import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { validVariantId } from "../cart/model.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { getMarketProductFoundation, marketFoundationVariant } from "../catalog/product-foundation.ts";
import { connectedOfferScope } from "../commerce/market-offers.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { slugField } from "../staff/catalog-input.ts";
import { nativeSourceSystem } from "./contracts.ts";

const referenceInput = z.strictObject({
  sourceSystem: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  entity: z.enum(["product", "variant"]),
  sourceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/),
});

export async function resolveMigratedProductSlug(rawSlug: string, db: DbReader = getDb()) {
  const slug = slugField.safeParse(rawSlug);
  if (!slug.success || slug.data !== rawSlug) return null;
  const alias = await db.catalogMigrationRedirect.findUnique({
    where: { slug: slug.data },
    select: { product: { select: { id: true, slug: true, migratedFromSlug: { select: { slug: true } } } } },
  });
  const product = alias?.product;
  if (!product || product.slug === rawSlug || product.migratedFromSlug) return null;
  const target = slugField.safeParse(product.slug);
  return target.success && target.data === product.slug ? { id: product.id, slug: target.data } : null;
}

export async function resolveMigratedProductLanding(slug: string, marketId: MarketId, variant: string | null, db: DbReader = getDb()) {
  const alias = await resolveMigratedProductSlug(slug, db);
  if (!alias) return null;
  const visibility = marketFoundationVariant(marketId, false);
  const target = await db.product.findFirst({ where: { id: alias.id, foundation: true, active: true, publication: "ACTIVE",
    variants: { some: visibility } }, select: { variants: {
      where: { ...visibility, id: validVariantId(variant) ? variant : { in: [] } }, select: { id: true },
    } } });
  return target && { slug: alias.slug, variantId: target.variants[0]?.id };
}

export async function resolveCatalogMigrationReference(raw: unknown, db: DbReader = getDb()) {
  const input = referenceInput.safeParse(raw);
  if (!input.success) return null;
  const { sourceSystem, entity, sourceId } = input.data;
  const row = await db.catalogMigrationMapping.findUnique({
    where: { sourceSystem_entity_sourceId: input.data }, select: { targetId: true },
  });
  const id = row?.targetId ?? (sourceSystem === nativeSourceSystem ? sourceId : null);
  if (!id) return null;
  if (entity === "product") {
    const product = await db.product.findUnique({ where: { id }, select: { id: true } });
    return product && { ...product, entity };
  }
  if (!validVariantId(id)) return null;
  const variant = await db.variant.findUnique({ where: { id }, select: { id: true } });
  return variant && { ...variant, entity };
}

export async function getMigratedProductBrowse(slug: string, marketId: MarketId, locale: string, db: DbReader = getDb()) {
  const product = await db.product.findUnique({ where: { slug }, select: { id: true, foundation: true } });
  if (!product?.foundation || !await db.catalogMigrationMapping.findFirst({
    where: { sourceSystem: nativeSourceSystem, entity: "product", targetId: product.id }, select: { sourceId: true },
  })) return null;
  const foundation = await getMarketProductFoundation(product.id, marketId, locale, db);
  if (!foundation) return null;
  const now = new Date();
  const offers = await db.marketOffer.findMany({
    where: { ...connectedOfferScope(marketId), variantId: { in: foundation.variants.map(variant => variant.id) } },
    select: { variantId: true, amountMinor: true, discountMinor: true, discountStartsAt: true, discountEndsAt: true },
  });
  const prices = new Map(offers.map(offer => [offer.variantId, offer.amountMinor - activeDiscount(offer, now)]));
  const variants = foundation.variants.map(variant => {
    const options = foundation.options.flatMap(option => {
      const value = option.values.find(item => item.id === variant.selections[option.id]);
      return value ? [{ name: option.label, value: value.label }] : [];
    });
    return { id: variant.id, options, image: variant.primaryImage, priceMinor: prices.get(variant.id) };
  });
  return {
    id: foundation.id, slug: foundation.slug, name: foundation.name, description: foundation.description,
    shortDescription: foundation.shortDescription, variants, defaultVariantId: foundation.defaultVariantId,
    images: foundation.images.map(({ src, alt }) => ({ src, alt })),
  };
}
