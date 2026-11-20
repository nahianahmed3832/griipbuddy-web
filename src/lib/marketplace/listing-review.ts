import { createHash, randomUUID } from "node:crypto";
import { markets, type MarketId } from "../../config/markets.ts";
import type { Prisma, SellerListingReview } from "../../generated/prisma/client.ts";
import { lockCommercialSeller } from "../commerce/commercial-access.ts";
import { lockVariantInventory } from "../commerce/location-inventory.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { resolveMarketScope } from "../market-config.ts";
import { firstPartyStoreMode, marketplaceMode, productionMode } from "../release-config.ts";
import { lockCatalogProductQuoteRows } from "../staff/catalog-locks.ts";
import { encodeCatalogImage, missingImage } from "../staff/catalog-media.ts";
import { canUseMarket } from "../staff/market-access.ts";
import { lockProductEdits } from "../staff/operations.ts";
import { categoryPlacementScope, lockTaxonomy } from "../staff/taxonomy-write.ts";
import {
  ListingReviewError, listingInput, listingReviewDecision, listingSku, sellerListingCommand, sellerListingDraft, validateListingDraft,
} from "./listing-review-input.ts";
import { applyApprovedListing, validateListingPublication, withdrawListingMarket } from "./listing-review-publication.ts";
import { getSellerAccess, resolveSellerAccess } from "./seller-access.ts";

export { ListingReviewError, listingReviewDecision, sellerListingCommand, sellerListingDraft } from "./listing-review-input.ts";
export type { SellerListingDraft, SellerListingVariant } from "./listing-review-input.ts";

type Tx = Prisma.TransactionClient;

function requireMarketplaceMarket(marketId: MarketId) {
  if (!marketplaceMode() || firstPartyStoreMode() || !resolveMarketScope(marketId)) {
    throw new ListingReviewError("Seller listing review is unavailable in this market.", 404);
  }
}

async function sellerShop(db: DbReader, shopperId: string, marketId: MarketId) {
  const shop = await db.marketplaceShop.findUnique({ where: { ownerId: shopperId }, select: { id: true, slug: true } });
  if (shop) return { ...shop, owner: true };
  const access = await resolveSellerAccess(shopperId, marketId, "LISTINGS", undefined, db);
  if (!access) throw new ListingReviewError("This shop is unavailable.", 404);
  return { id: access.shop.id, slug: access.shop.slug, owner: false };
}

async function requireSellerMarket(db: DbReader, shopId: string, shopperId: string, marketId: MarketId) {
  if (!await getSellerAccess(shopperId, shopId, marketId, "LISTINGS", db)) {
    throw new ListingReviewError("Your shop needs current approval to sell in this market.", 403);
  }
}

async function requireReviewer(db: DbReader, actorId: string, marketId: MarketId) {
  requireMarketplaceMarket(marketId);
  if (!await canUseMarket(actorId, marketId, "merchandising", db)) {
    throw new ListingReviewError("You do not have catalog review access in this market.", 403);
  }
}

function listingView({ productId, marketId, revision, state, draft, feedback, updatedAt }: SellerListingReview) {
  return { productId, marketId, revision, state, draft: sellerListingDraft.parse(draft), feedback, updatedAt: updatedAt.toISOString() };
}

export async function sellerListingReview(shopperId: string, productId: string, marketId: MarketId) {
  if (!marketplaceMode() || firstPartyStoreMode()) return null;
  const access = await sellerShop(getDb(), shopperId, marketId).catch(error => {
    if (error instanceof ListingReviewError && error.status === 404) return null;
    throw error;
  });
  if (!access) return null;
  const row = await getDb().sellerListingReview.findFirst({
    where: { productId, marketId, product: { marketplaceShopId: access.id } },
  });
  return row ? listingView(row) : null;
}

export async function sellerListingMarkets(shopperId: string, productId: string, marketId?: MarketId) {
  if (!marketplaceMode() || firstPartyStoreMode()) return [];
  const access = marketId && await resolveSellerAccess(shopperId, marketId, "LISTINGS");
  const rows = await getDb().sellerListingReview.findMany({
    where: { productId, ...(access && !access.owner
      ? { marketId, product: { marketplaceShopId: access.shop.id } } : { product: { marketplaceShop: { ownerId: shopperId } } }) },
    select: { marketId: true },
  });
  return rows.map(row => row.marketId);
}

export async function reviewerListingQueue(actorId: string, marketId: MarketId, query?: string) {
  const db = getDb();
  await requireReviewer(db, actorId, marketId);
  const q = query?.trim().slice(0, 100);
  const rows = await db.sellerListingReview.findMany({
    where: { marketId, state: { in: ["SUBMITTED", "APPROVED"] }, ...(q && { OR: [
      { productId: { contains: q, mode: "insensitive" } },
      { product: { marketplaceShop: { name: { contains: q, mode: "insensitive" } } } },
      { draft: { path: ["name"], string_contains: q, mode: "insensitive" } },
    ] }) },
    orderBy: [{ updatedAt: "asc" }, { productId: "asc" }], take: 100,
    include: { product: { select: { marketplaceShop: { select: { name: true } } } } },
  });
  return rows.map(row => ({ ...listingView(row), shopName: row.product.marketplaceShop?.name ?? "Unavailable shop" }));
}

async function validateDraft(db: DbReader, raw: unknown, shopId: string, productId: string | undefined, submitting: boolean) {
  const draft = listingInput(sellerListingDraft, raw);
  validateListingDraft(draft, submitting);
  const issued = draft.variants.flatMap(variant => variant.id ? [variant.id] : []);
  if (issued.length && (!productId || await db.variant.count({ where: { id: { in: issued }, productId } }) !== issued.length)) {
    throw new ListingReviewError("Choose issued variants from this listing.", 409);
  }
  if (!await db.department.findFirst({ where: categoryPlacementScope([draft.departmentId], false), select: { id: true } })) {
    throw new ListingReviewError("Choose an active product subcategory.");
  }
  if (draft.image?.src.startsWith("/media/")) {
    const enrolled = await db.sellerListingAsset.findUnique({
      where: { shopId_mediaId: { shopId, mediaId: draft.image.src.slice(7) } }, select: { mediaId: true },
    });
    const attached = productId && await db.productImage.findFirst({
      where: { productId, src: draft.image.src, product: { marketplaceShopId: shopId } }, select: { src: true },
    });
    if (!enrolled && !attached) throw new ListingReviewError("Upload an image to your own listing workspace.");
  } else if (draft.image && (productionMode() || await missingImage(db, [draft.image.src]))) {
    throw new ListingReviewError("Choose an approved catalog image.");
  }
  if (draft.variants.length && await db.variant.findFirst({
    where: { ...(productId && { productId: { not: productId } }),
      sku: { in: draft.variants.map(variant => listingSku(shopId, variant.sku)), mode: "insensitive" } },
    select: { id: true },
  })) {
    throw new ListingReviewError("A SKU is already in use by your shop.", 409);
  }
  return draft;
}

export async function validateSellerListingDraft(shopperId: string, marketId: MarketId, raw: unknown, operationId?: string) {
  requireMarketplaceMarket(marketId);
  const db = getDb();
  const shop = await sellerShop(db, shopperId, marketId);
  await requireSellerMarket(db, shop.id, shopperId, marketId);
  if (operationId) {
    const productId = creationId(shopperId, marketId, operationId);
    const prior = await db.sellerListingReview.findFirst({
      where: { productId, marketId, product: { marketplaceShopId: shop.id, publication: { not: "ARCHIVED" } } },
      select: { creationRequestHash: true },
    });
    if (prior) {
      const draft = listingInput(sellerListingDraft, raw);
      if (prior.creationRequestHash === draftRequestHash(draft)) return draft;
      throw new ListingReviewError("This listing key already created a different draft.", 409);
    }
  }
  return validateDraft(db, raw, shop.id, undefined, false);
}

function creationId(shopperId: string, marketId: MarketId, operationId: string | undefined) {
  if (!operationId) return "p-" + randomUUID();
  return "p-" + createHash("sha256").update(JSON.stringify([shopperId, marketId, operationId])).digest("hex").slice(0, 32);
}

function draftRequestHash(draft: ReturnType<typeof sellerListingDraft.parse>) {
  const ordered = { ...draft, variants: draft.variants.map(variant => ({
    ...variant, options: Object.fromEntries(Object.entries(variant.options).sort(([a], [b]) => a.localeCompare(b, "en"))),
  })) };
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function checkRevision(row: SellerListingReview | null, expected: number | undefined) {
  if (row?.revision !== expected) throw new ListingReviewError("This listing review changed. Reload and try again.", 409);
}

async function lockListing(tx: Tx, productId: string) {
  await lockTaxonomy(tx);
  await lockProductEdits(tx, productId);
  const variants = await tx.variant.findMany({ where: { productId }, select: { id: true } });
  await lockVariantInventory(tx, variants.map(variant => variant.id));
  await lockCatalogProductQuoteRows(tx, productId);
}

async function auditListing(tx: Tx, row: SellerListingReview, shopId: string, actor: { staffId?: string; shopperId?: string }) {
  await tx.auditEvent.create({ data: { actorId: actor.staffId, action: "PRODUCT_SAVED", target: row.productId, changes: {
    kind: "seller-listing-review", shopId, marketId: row.marketId, revision: row.revision, state: row.state,
    ...(actor.shopperId && { shopperId: actor.shopperId }),
  } } });
}

export async function saveSellerListing(shopperId: string, raw: unknown) {
  const action = listingInput(sellerListingCommand, raw);
  const { marketId } = action;
  requireMarketplaceMarket(marketId);
  const retryableCreate = action.action === "save" && !action.productId && Boolean(action.operationId);
  if (action.action === "save" && (!action.productId && action.revision !== undefined || action.productId && action.operationId)) {
    throw new ListingReviewError("A new listing and an existing listing use different revision fields.", 400);
  }
  const productId = action.productId ?? creationId(shopperId, marketId, action.action === "save" ? action.operationId : undefined);
  return getDb().$transaction(async tx => {
    const shop = await sellerShop(tx, shopperId, marketId);
    await lockListing(tx, productId);
    if (action.action === "save" && !action.productId) {
      await tx.$queryRaw`SELECT id FROM "MarketplaceShop" WHERE id = ${shop.id}::uuid FOR UPDATE`;
    } else {
      await lockCommercialSeller(tx, shop.id);
    }
    if (action.action !== "withdraw" || !shop.owner) await requireSellerMarket(tx, shop.id, shopperId, marketId);
    const key = { productId, marketId };
    const where = { productId_marketId: key };
    const product = await tx.product.findUnique({
      where: { id: productId }, select: { id: true, marketplaceShopId: true, foundation: true, revision: true, publication: true,
        sellerListingReviews: { select: { marketId: true }, take: 1 } },
    });
    const prior = await tx.sellerListingReview.findUnique({ where });
    if (product && (product.marketplaceShopId !== shop.id || !product.foundation || !product.sellerListingReviews.length)) {
      throw new ListingReviewError("This listing is unavailable.", 404);
    }
    if (product?.publication === "ARCHIVED") throw new ListingReviewError("This listing is archived.", 409);
    if (action.action === "save" && retryableCreate && prior) {
      if (prior.creationRequestHash === draftRequestHash(action.draft)) return listingView(prior);
      throw new ListingReviewError("This operation already created a different draft.", 409);
    }
    checkRevision(prior, action.revision);
    if (action.action === "save") {
      if (action.productId && !product) throw new ListingReviewError("This listing is unavailable.", 404);
      const draft = await validateDraft(tx, action.draft, shop.id, product?.id, false);
      if (!product) {
        if (await tx.product.count({ where: { marketplaceShopId: shop.id } }) >= 30) {
          throw new ListingReviewError("This workspace allows 30 listings per shop.", 409);
        }
        await tx.product.create({ data: {
          id: productId, slug: `${shop.slug.slice(0, 46).replace(/-+$/u, "")}-${productId.slice(2)}`, marketplaceShopId: shop.id,
          name: draft.name, description: draft.description, departmentId: draft.departmentId, active: false,
          keywords: [], specifications: [], addedOn: new Date(), position: 10_000, foundation: true, demo: !productionMode(),
        } });
      }
      const data = { baseProductRevision: product?.revision ?? 0, draft, feedback: null, state: "DRAFT" as const };
      const row = prior ? await tx.sellerListingReview.update({ where, data: { ...data, revision: { increment: 1 } } })
        : await tx.sellerListingReview.create({ data: { ...data, ...key, creationRequestHash: retryableCreate ? draftRequestHash(draft) : null } });
      await auditListing(tx, row, shop.id, { shopperId });
      return listingView(row);
    }
    if (!product || !prior) throw new ListingReviewError("This listing is unavailable.", 404);
    if (action.action === "submit") {
      if (prior.state !== "DRAFT") throw new ListingReviewError("Save a draft before submitting this listing.", 409);
      if (prior.baseProductRevision !== product.revision) throw new ListingReviewError("The catalog changed. Refresh and save the draft.", 409);
      await validateDraft(tx, prior.draft, shop.id, productId, true);
    } else {
      await withdrawListingMarket(tx, productId, shop.id, marketId);
    }
    const row = await tx.sellerListingReview.update({ where, data: {
      state: action.action === "submit" ? "SUBMITTED" : "WITHDRAWN", revision: { increment: 1 }, feedback: null,
    } });
    await auditListing(tx, row, shop.id, { shopperId });
    return listingView(row);
  });
}

export async function reviewSellerListing(actorId: string, marketId: MarketId, raw: unknown) {
  const input = listingInput(listingReviewDecision, raw);
  const db = getDb();
  await requireReviewer(db, actorId, marketId);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actorId} FOR SHARE`;
    await tx.$queryRaw`SELECT "userId" FROM "StaffMarketAccess" WHERE "userId" = ${actorId} AND "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
    await requireReviewer(tx, actorId, marketId);
    const { productId, revision } = input;
    await lockListing(tx, productId);
    const where = { productId_marketId: { productId, marketId } };
    const row = await tx.sellerListingReview.findUnique({ where, include: {
      product: { select: { revision: true, publication: true, marketplaceShop: { select: { id: true, ownerId: true } } } },
    } });
    if (!row?.product.marketplaceShop?.ownerId) throw new ListingReviewError("This submission is unavailable.", 404);
    checkRevision(row, revision);
    const requiredState = input.decision === "publish" ? "APPROVED" : "SUBMITTED";
    if (row.state !== requiredState) {
      throw new ListingReviewError(input.decision === "publish"
        ? "Approve the current submission before publishing it." : "Only a submitted listing can be reviewed.", 409);
    }
    const shop = row.product.marketplaceShop;
    let draft = listingInput(sellerListingDraft, row.draft);
    if (input.decision !== "reject") {
      if (row.product.publication === "ARCHIVED" || row.product.revision !== row.baseProductRevision) {
        throw new ListingReviewError("The catalog changed since submission. Ask the seller to refresh and resubmit.", 409);
      }
      await lockCommercialSeller(tx, shop.id);
      await requireSellerMarket(tx, shop.id, row.product.marketplaceShop.ownerId, marketId);
      draft = await validateDraft(tx, draft, shop.id, productId, true);
      const publication = { productId, shopId: shop.id, marketId, currency: markets[marketId].currency, draft };
      if (input.decision === "publish") draft = await applyApprovedListing(tx, publication);
      else await validateListingPublication(tx, publication);
    }
    const state = { approve: "APPROVED", reject: "REJECTED", publish: "PUBLISHED" } as const;
    const reviewed = await tx.sellerListingReview.update({ where, data: {
      draft, revision: { increment: 1 }, state: state[input.decision],
      feedback: input.feedback ?? (input.decision === "publish" ? row.feedback : null),
    } });
    await auditListing(tx, reviewed, shop.id, { staffId: actorId });
    return listingView(reviewed);
  });
}

export async function storeSellerListingImage(shopperId: string, marketId: MarketId, data: Buffer, contentType: string) {
  requireMarketplaceMarket(marketId);
  const db = getDb();
  const shop = await sellerShop(db, shopperId, marketId);
  await requireSellerMarket(db, shop.id, shopperId, marketId);
  const media = await encodeCatalogImage(data, contentType);
  await db.$transaction(async tx => {
    await lockCommercialSeller(tx, shop.id);
    await requireSellerMarket(tx, shop.id, shopperId, marketId);
    await tx.catalogMedia.upsert({ where: { id: media.id }, update: {}, create: media });
    const key = { shopId: shop.id, mediaId: media.id };
    await tx.sellerListingAsset.upsert({ where: { shopId_mediaId: key }, update: {}, create: key });
  });
  return { src: `/media/${media.id}` };
}
