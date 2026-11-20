import { z } from "zod";
import { markets, type MarketId } from "../../config/markets.ts";
import type { MarketOffer, Prisma } from "../../generated/prisma/client.ts";
import { validVariantId } from "../cart/model.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable, marketConfiguration, marketIdInput } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { firstPartyStoreMode, productionMode } from "../release-config.ts";
import { CatalogWriteError, OperationError, catalogWriteInput } from "../staff/operation-error.ts";
import { authorizeCommercialActor, connectedSellerVisibility, lockCommercialSeller, type CommercialActor } from "./commercial-access.ts";
import { lockVariantInventory } from "./location-inventory.ts";

const minorAmount = z.number().int().min(1).max(2_147_483_647);
const timestamp = z.union([z.date(), z.iso.datetime({ offset: true }).transform(value => new Date(value))]).nullish();
const offerInput = z.strictObject({
  variantId: z.string().refine(validVariantId, "Choose a valid variant."),
  marketId: marketIdInput,
  sellerId: z.uuid().transform(value => value.toLowerCase()),
  expectedRevision: z.number().int().min(0).max(2_147_483_646).nullable(),
  currency: z.string().length(3).optional(),
  amountMinor: minorAmount,
  salePriceMinor: minorAmount.nullish(),
  saleStartsAt: timestamp,
  saleEndsAt: timestamp,
  publication: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
  eligible: z.boolean(),
}).superRefine((offer, ctx) => {
  if (offer.currency !== undefined && offer.currency !== markets[offer.marketId].currency) {
    ctx.addIssue({ code: "custom", message: "Use the selected market’s currency.", path: ["currency"] });
  }
  const { salePriceMinor, saleStartsAt, saleEndsAt } = offer;
  if ((salePriceMinor != null || saleStartsAt || saleEndsAt) &&
    (salePriceMinor == null || salePriceMinor >= offer.amountMinor || !saleStartsAt || !saleEndsAt || saleStartsAt >= saleEndsAt)) {
    ctx.addIssue({ code: "custom", message: "Supply a lower sale price and an ordered start and end.", path: ["salePriceMinor"] });
  }
  if (offer.publication !== "ACTIVE" && offer.eligible) {
    ctx.addIssue({ code: "custom", message: "Publish the offer before enabling purchase.", path: ["eligible"] });
  }
});

function offerTerms(offer: MarketOffer) {
  return {
    revision: offer.revision, currency: offer.currency, amountMinor: offer.amountMinor, discountMinor: offer.discountMinor,
    discountStartsAt: offer.discountStartsAt?.toISOString() ?? null, discountEndsAt: offer.discountEndsAt?.toISOString() ?? null,
    publication: offer.publication, eligible: offer.eligible,
  };
}

export function connectedOfferScope(marketId: MarketId): Prisma.MarketOfferWhereInput {
  return {
    marketId, currency: markets[marketId].currency, publication: "ACTIVE",
    identity: { is: { retiredAt: null, seller: connectedSellerVisibility(marketId) } },
    variant: { active: true, archivedAt: null, optionSignature: { not: null }, product: {
      foundation: true, active: true, publication: "ACTIVE",
      ...((firstPartyStoreMode() || productionMode()) && { demo: false }),
    } },
  };
}

export async function readConnectedOffer(variantId: string, marketId: MarketId, db: DbReader = getDb(), now = new Date()) {
  if (!isMarketSelectable(marketId) || !validVariantId(variantId)) return null;
  const market = marketConfiguration(marketId);
  const offer = await db.marketOffer.findFirst({
    where: { variantId, ...connectedOfferScope(marketId) },
    include: { identity: { select: { id: true, sellerId: true } } },
  });
  if (!offer?.identity) return null;
  return {
    id: offer.identity.id, variantId, marketId, sellerId: offer.identity.sellerId, currency: offer.currency, minorDigits: market.minorDigits,
    revision: offer.revision, amountMinor: offer.amountMinor - activeDiscount(offer, now),
    regularMinor: offer.amountMinor, eligible: offer.eligible && market.status !== "paused",
  };
}

async function lockOfferEdit(tx: Prisma.TransactionClient, variantId: string, marketId: MarketId) {
  // Match checkout's inventory advisory -> offer -> variant/product -> seller order.
  await lockVariantInventory(tx, [variantId]);
  await tx.$queryRaw`
    SELECT "variantId" FROM "MarketOffer"
    WHERE "marketId" = ${marketId}::"MarketCode" AND "variantId" = ${variantId} FOR UPDATE
  `;
  await tx.$queryRaw`
    SELECT v.id FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
    WHERE v.id = ${variantId} FOR SHARE OF v, p
  `;
}

export async function saveConnectedOffer(actor: CommercialActor, raw: unknown,
  validatePurchase?: (db: DbReader, offer: { variantId: string; marketId: MarketId; sellerId: string }) => Promise<void>) {
  const input = catalogWriteInput(offerInput, raw);
  const { variantId, marketId, sellerId, expectedRevision, amountMinor, salePriceMinor, publication, eligible } = input;
  const key = { variantId, marketId };
  const where = { variantId_marketId: key };
  const currency = markets[marketId].currency;
  return getDb().$transaction(async tx => {
    await lockOfferEdit(tx, variantId, marketId);
    const { central } = await authorizeCommercialActor(tx, actor, { marketId, sellerId });
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: {
      optionSignature: true, archivedAt: true, active: true,
      product: { select: { foundation: true, marketplaceShopId: true, publication: true, sellerListingReviews: { take: 1, select: { marketId: true } } } },
    } });
    if (!variant?.product.foundation || variant.optionSignature === null ||
      (publication === "ACTIVE" && (!variant.active || variant.archivedAt))) {
      throw new CatalogWriteError("not_found", "Choose a current catalog foundation variant.");
    }
    if (variant.product.sellerListingReviews.length) throw new CatalogWriteError("conflict", "Change this offer through the seller listing review.");
    const previous = await tx.marketOffer.findUnique({ where, include: { identity: true } });
    const assignedSeller = previous?.identity?.sellerId ?? variant.product.marketplaceShopId ?? storeShop.id;
    if (!central && sellerId !== assignedSeller) throw new CatalogWriteError("forbidden", "Only a central owner may assign a different seller.");
    if (variant.product.publication === "ARCHIVED") {
      throw new CatalogWriteError("conflict", "Offers are read-only for an archived product.");
    }
    if (previous && !previous.identity) throw new CatalogWriteError("conflict", "Existing market offers must be reconciled during catalog migration.");
    if ((previous?.revision ?? null) !== expectedRevision) throw new CatalogWriteError("conflict", "The offer changed. Reload it before editing.");
    if (publication === "ARCHIVED" && (!previous || sellerId !== assignedSeller)) {
      throw new OperationError("Archive the existing offer before assigning a replacement seller.");
    }
    if (publication === "ARCHIVED" && previous?.identity?.retiredAt) {
      return { id: previous.identity.id, ...key, sellerId, ...offerTerms(previous) };
    }
    if (publication !== "ARCHIVED") {
      if (actor.kind !== "seller") await lockCommercialSeller(tx, sellerId);
      const seller = await tx.marketplaceShop.findFirst({
        where: { AND: [{ id: sellerId }, connectedSellerVisibility(marketId)] }, select: { id: true },
      });
      if (!seller) throw new CatalogWriteError("forbidden", "This seller does not have permission to sell in the selected market.");
    }
    if (publication === "ACTIVE" && eligible) await validatePurchase?.(tx, { ...key, sellerId });

    const priorIdentity = previous?.identity;
    const replace = !priorIdentity || priorIdentity.sellerId !== sellerId || !!priorIdentity.retiredAt;
    if (previous && priorIdentity && !priorIdentity.retiredAt && (replace || publication === "ARCHIVED")) {
      await tx.marketOfferIdentity.update({
        where: { id: priorIdentity.id }, data: { retiredAt: new Date(), retiredTerms: offerTerms(previous) },
      });
    }
    const identity = replace
      ? await tx.marketOfferIdentity.create({ data: { ...key, sellerId }, select: { id: true } })
      : priorIdentity;
    const terms = {
      offerId: identity.id, currency, amountMinor, publication, eligible,
      discountMinor: salePriceMinor == null ? null : amountMinor - salePriceMinor,
      discountStartsAt: input.saleStartsAt ?? null, discountEndsAt: input.saleEndsAt ?? null,
    };
    const offer = previous
      ? await tx.marketOffer.update({ where, data: { ...terms, revision: { increment: 1 } } })
      : await tx.marketOffer.create({ data: { ...key, ...terms } });

    await tx.auditEvent.create({
      data: {
        action: "PRICE_CHANGED", target: variantId, ...(actor.kind === "staff" && { actorId: actor.id }),
        changes: { source: "connected-offer", marketId, sellerId, offerId: identity.id, actor,
          previousOfferId: priorIdentity?.id ?? null, before: previous ? offerTerms(previous) : null, after: offerTerms(offer) },
      },
    });
    return { id: identity.id, ...key, sellerId, ...offerTerms(offer) };
  });
}
