import { randomUUID } from "node:crypto";
import type { MarketId } from "../../config/markets.ts";
import type { MarketOffer, Prisma } from "../../generated/prisma/client.ts";
import type { CurrencyCode } from "../../generated/prisma/enums.ts";
import { categoryAttributes, validateCategoryAttributeValues } from "../catalog/category-attributes.ts";
import { variantOptionSignature } from "../catalog/option-signature.ts";
import {
  ListingReviewError, listingOptions, listingSku, type SellerListingDraft, type SellerListingVariant,
} from "./listing-review-input.ts";

type Tx = Prisma.TransactionClient;

const productShape = {
  variants: { orderBy: [{ position: "asc" }, { id: "asc" }] },
  images: { orderBy: { position: "asc" } },
  optionDefinitions: { include: { values: true }, orderBy: { position: "asc" } },
} as const satisfies Prisma.ProductInclude;

type Product = Prisma.ProductGetPayload<{ include: typeof productShape }>;

function sameOptions(first: Prisma.JsonValue, second: Record<string, string>) {
  const pairs = (obj: unknown) => obj && typeof obj === "object" ? Object.entries(obj).sort(([a], [b]) => a.localeCompare(b, "en")) : [];
  return JSON.stringify(pairs(first)) === JSON.stringify(pairs(second));
}

function changesSharedProduct(product: Product, draft: SellerListingDraft) {
  if (product.name !== draft.name || product.description !== draft.description || product.departmentId !== draft.departmentId ||
    product.images[0]?.src !== draft.image?.src || product.images[0]?.alt !== draft.image?.alt ||
    product.variants.length !== draft.variants.length) return true;
  return draft.variants.some((variant, index) => {
    const prior = product.variants[index];
    return prior.id !== variant.id || prior.label !== variant.label || prior.isDefault !== variant.isDefault ||
      prior.active === Boolean(variant.retired) || !sameOptions(prior.options, variant.options);
  });
}

function validateIssuedVariants(product: Product, shopId: string, draft: SellerListingDraft) {
  const variants = new Map(draft.variants.map(variant => [variant.id, variant]));
  if (draft.variants.some(variant => variant.id && !product.variants.some(prior => prior.id === variant.id))) {
    throw new ListingReviewError("Choose issued variants from this listing.", 409);
  }
  for (const prior of product.variants) {
    const next = variants.get(prior.id);
    if (!next) throw new ListingReviewError("Retire an issued variant instead of removing it.", 409);
    if (listingSku(shopId, next.sku) !== prior.sku || !sameOptions(prior.options, next.options)) {
      throw new ListingReviewError("Issued SKUs and option combinations stay attached to their original variant.", 409);
    }
    if (prior.archivedAt && !next.retired) throw new ListingReviewError("A retired variant cannot be reactivated.", 409);
  }
}

async function validateCategoryOptions(tx: Tx, draft: SellerListingDraft) {
  const templates = await categoryAttributes(draft.departmentId, tx);
  const issues = validateCategoryAttributeValues(templates, {
    productValues: {},
    variants: draft.variants.map((variant, index) => ({
      id: variant.id ?? String(index + 1), active: !variant.retired, values: {}, options: Object.fromEntries(listingOptions(variant).map(({ key, value }) => [key, value])),
    })),
  });
  if (issues.length) throw new ListingReviewError("This category requires additional catalog attributes. Choose another category or ask catalog staff for help.");
}

function optionValueKey(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

async function saveOptions(tx: Tx, product: Product, draft: SellerListingDraft) {
  const definitions = new Map(product.optionDefinitions.map(row => [row.key, row]));
  const values = new Map<string, Map<string, string>>();
  for (const [position, option] of listingOptions(draft.variants[0]).entries()) {
    const prior = definitions.get(option.key);
    const optionId = prior?.id ?? randomUUID();
    const rows = new Map(prior?.values.map(row => [optionValueKey(row.value), row.id]));
    if (!prior) {
      await tx.productOption.create({ data: { productId: product.id, id: optionId, key: option.key, label: option.label, position } });
    }
    for (const variant of draft.variants) {
      const value = listingOptions(variant).find(row => row.key === option.key)!.value;
      const canonical = optionValueKey(value);
      if (rows.has(canonical)) continue;
      const id = randomUUID();
      await tx.productOptionValue.create({ data: {
        productId: product.id, optionId, id, value: canonical, label: value, position: rows.size,
      } });
      rows.set(canonical, id);
    }
    values.set(option.key, rows);
    if (!prior) definitions.set(option.key, { id: optionId, key: option.key, productId: product.id, label: option.label, position, values: [] });
  }
  return (variant: SellerListingVariant) => Object.fromEntries(listingOptions(variant).map(({ key, value }) =>
    [definitions.get(key)!.id, values.get(key)!.get(optionValueKey(value))!]));
}

async function requireSafeRetirement(tx: Tx, variantId: string) {
  const stock = await tx.variant.findFirst({ where: { id: variantId, OR: [
    { inventory: { available: { gt: 0 } } },
    { locationInventory: { some: { available: { gt: 0 } } } },
    { inventoryPools: { some: { OR: [
      { onHand: { gt: 0 } }, { reserved: { gt: 0 } }, { inboundTransfers: { some: { receivedAt: null } } },
      { outboundTransfers: { some: { receivedAt: null } } },
    ] } } },
    { offerIdentities: { some: { allocations: { some: { reservation: { state: { in: ["HELD", "PAYMENT_EXCEPTION"] } } } } } } },
  ] }, select: { id: true } });
  if (stock) throw new ListingReviewError("Reconcile remaining stock, reservations and transfers before retiring this variant.", 409);
}

function historicalTerms(offer: MarketOffer) {
  return {
    revision: offer.revision, currency: offer.currency, amountMinor: offer.amountMinor, discountMinor: offer.discountMinor,
    discountStartsAt: offer.discountStartsAt?.toISOString() ?? null, discountEndsAt: offer.discountEndsAt?.toISOString() ?? null,
    publication: offer.publication, eligible: offer.eligible,
  };
}

async function retireVariantOffers(tx: Tx, variantId: string) {
  const offers = await tx.marketOffer.findMany({
    where: { variantId, publication: { not: "ARCHIVED" } },
  });
  for (const offer of offers) {
    if (offer.offerId) await tx.marketOfferIdentity.updateMany({
      where: { id: offer.offerId, retiredAt: null }, data: { retiredAt: new Date(), retiredTerms: historicalTerms(offer) },
    });
    await tx.marketOffer.update({
      where: { variantId_marketId: { variantId, marketId: offer.marketId } },
      data: { publication: "ARCHIVED", eligible: false, revision: { increment: 1 } },
    });
  }
}

async function applyVariantOffer(tx: Tx, variantId: string, marketId: MarketId, currency: CurrencyCode, shopId: string, amount: number | null) {
  const key = { variantId, marketId };
  const where = { variantId_marketId: key };
  const existing = await tx.marketOffer.findUnique({ where, include: { identity: true } });
  if (existing && (existing.identity?.sellerId !== shopId || existing.identity.retiredAt)) {
    throw new ListingReviewError("This offer belongs to a different authority or is retired.", 409);
  }
  if (amount === null) {
    if (existing?.publication === "ACTIVE") await tx.marketOffer.update({
      where, data: { publication: "DRAFT", eligible: false, revision: { increment: 1 } },
    });
    return;
  }
  const offer = { currency, amountMinor: amount, publication: "ACTIVE" as const, eligible: true };
  if (!existing) {
    const identity = await tx.marketOfferIdentity.create({ data: { ...key, sellerId: shopId }, select: { id: true } });
    await tx.marketOffer.create({ data: { ...key, ...offer, offerId: identity.id } });
  } else if (existing.amountMinor !== amount || existing.publication !== "ACTIVE" || !existing.eligible) {
    await tx.marketOffer.update({ where, data: {
      ...offer, revision: { increment: 1 }, discountMinor: null, discountStartsAt: null, discountEndsAt: null,
    } });
  }
}

type ListingPublication = {
  productId: string; shopId: string; marketId: MarketId; currency: CurrencyCode; draft: SellerListingDraft;
};

export async function validateListingPublication(tx: Tx, input: ListingPublication) {
  const { productId, shopId, marketId, draft } = input;
  const product = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: productShape });
  validateIssuedVariants(product, shopId, draft);
  await validateCategoryOptions(tx, draft);
  const shared = changesSharedProduct(product, draft);
  if (shared && await tx.marketOffer.count({
    where: { variant: { productId }, publication: "ACTIVE", marketId: { not: marketId }, identity: { sellerId: shopId } },
  })) {
    throw new ListingReviewError("Another market is live. Withdraw that market before changing shared catalog details or variants.", 409);
  }

  if (shared) {
    // SKU and inventory references survive retirement. Check the stock before changing the canonical variant.
    for (const variant of draft.variants) {
      if (!variant.id || !variant.retired || !product.variants.some(row => row.id === variant.id && row.active)) continue;
      await requireSafeRetirement(tx, variant.id);
    }
  }

  return { product, shared };
}

export async function applyApprovedListing(tx: Tx, input: ListingPublication) {
  const { productId, shopId, marketId, currency, draft } = input;
  const { product, shared } = await validateListingPublication(tx, input);
  const selectionFor = shared ? await saveOptions(tx, product, draft) : undefined;
  if (shared) await tx.variant.updateMany({ where: { productId, isDefault: true }, data: { isDefault: false } });
  const variants = [];
  for (const [position, variant] of draft.variants.entries()) {
    const id = variant.id ?? "v-" + randomUUID();
    if (selectionFor) {
      const selections = selectionFor(variant);
      const prior = product.variants.find(row => row.id === id);
      const fields = {
        active: !variant.retired, archivedAt: variant.retired ? prior?.archivedAt ?? new Date() : null,
        isDefault: variant.isDefault, position, label: variant.label,
      };
      if (prior) {
        await tx.variant.update({ where: { id }, data: fields });
      } else {
        await tx.variant.create({ data: {
          id, productId, ...fields, sku: listingSku(shopId, variant.sku), options: variant.options,
          optionSignature: variantOptionSignature(selections), managedInventory: true,
        } });
        if (Object.keys(selections).length) await tx.variantOptionSelection.createMany({
          data: Object.entries(selections).map(([optionId, optionValueId]) => ({ variantId: id, productId, optionId, optionValueId })),
        });
      }
    }
    if (variant.retired) {
      if (shared) await retireVariantOffers(tx, id);
    } else {
      await applyVariantOffer(tx, id, marketId, currency, shopId, variant.amountMinor);
    }
    variants.push({ ...variant, id });
  }
  if (shared && draft.image) {
    await tx.productImage.upsert({
      where: { productId_position: { productId, position: 0 } },
      create: { productId, position: 0, ...draft.image, isPrimary: true },
      update: { ...draft.image, isPrimary: true },
    });
  }
  if (shared || product.publication !== "ACTIVE" || !product.active) {
    await tx.product.update({
      where: { id: productId },
      data: { name: draft.name, description: draft.description, departmentId: draft.departmentId,
        active: true, publication: "ACTIVE", revision: { increment: 1 } },
    });
  }
  return { ...draft, variants };
}

export async function withdrawListingMarket(tx: Tx, productId: string, shopId: string, marketId: MarketId) {
  const ownOffer = { variant: { productId }, identity: { sellerId: shopId }, publication: "ACTIVE" } as const;
  const result = await tx.marketOffer.updateMany({
    where: { ...ownOffer, marketId }, data: { publication: "DRAFT", eligible: false, revision: { increment: 1 } },
  });
  if (result.count && !await tx.marketOffer.count({ where: ownOffer })) {
    await tx.product.updateMany({ where: { id: productId, publication: "ACTIVE" }, data: {
      active: false, publication: "DRAFT", revision: { increment: 1 },
    } });
  }
}
