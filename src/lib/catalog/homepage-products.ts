import { connectedOfferScope } from "../commerce/market-offers.ts";
import { inventoryPoolScopeKey, marketRoutedInventory } from "../commerce/physical-inventory.ts";
import type { DbReader } from "../db/client.ts";
import type { MarketConfiguration } from "../market-config.ts";
import { catalogProduct, catalogVariantInclude, catalogVariants } from "./connected-public.ts";
import { catalogLocaleChain } from "./category-presentation.ts";
import { selectProductContent } from "./product-presentation.ts";
import { catalog } from "./repository.ts";
import type { CatalogProduct, ListedVariant } from "./types.ts";

export type HomepageCatalogProduct = CatalogProduct & { categoryIds: readonly string[] };

export async function homepageProducts(db: DbReader, market: MarketConfiguration, at: Date) {
  const { id: marketId, currency, locale } = market;
  const context = { marketId, locale };
  const include = catalogVariantInclude(context);
  const [legacy, rows] = await Promise.all([
    catalog.listProducts({ marketId, at }),
    db.variant.findMany({
      where: { managedInventory: true, offers: { some: { ...connectedOfferScope(marketId), eligible: true } } },
      include: { ...include, product: { select: { ...include.product.select, newArrival: true, featured: true } } },
      orderBy: [{ product: { position: "asc" } }, { position: "asc" }, { id: "asc" }],
    }),
  ]);
  const sources = new Map(rows.map(row => [row.id, row.product]));
  const [variants, legacyPresentation] = await Promise.all([
    catalogVariants(rows, context, db, at),
    legacy.length ? db.product.findMany({
      where: { id: { in: legacy.map(product => product.id) } },
      select: { id: true, position: true, secondaryCategories: { select: { departmentId: true } },
        translations: { where: { locale: { in: catalogLocaleChain(locale) } } } },
    }) : [],
  ]);
  const availability = await marketRoutedInventory(db, marketId, variants.filter(variant => variant.offer.eligible && variant.offer.id)
    .map(({ id, offer }) => ({ variantId: id, ownerId: offer.sellerId })));
  const legacyById = new Map(legacyPresentation.map(row => [row.id, row]));
  const products = new Map<string, { product: HomepageCatalogProduct; position: number }>();
  for (const product of legacy) {
    const source = legacyById.get(product.id);
    const content = selectProductContent(product, source?.translations ?? [], locale);
    products.set(product.id, { position: source?.position ?? 0, product: { ...product, ...content,
      categoryIds: [product.departmentId, ...source?.secondaryCategories.map(row => row.departmentId) ?? []] } });
  }
  for (const variant of variants) {
    const { id, sku, image, offer } = variant;
    const stock = availability.get(inventoryPoolScopeKey({ variantId: id, ownerId: offer.sellerId })) ?? 0;
    if (!stock || !offer.eligible || !offer.id || offer.currency !== currency) continue;
    const source = sources.get(id)!;
    const candidate: ListedVariant = {
      id, sku, image: image ?? undefined, options: Object.fromEntries(variant.options.map(option => [option.label, option.valueLabel])),
      offer: { id: offer.id, variantId: id, marketId, currency, stock, amountMinor: offer.amountMinor, regularMinor: offer.regularMinor,
        ...(offer.promotionEndsAt && { promotion: { endsAt: offer.promotionEndsAt,
          remainingSeconds: Math.ceil((Date.parse(offer.promotionEndsAt) - +at) / 1_000) } }) },
    };
    const existing = products.get(source.id);
    if (existing) {
      existing.product.variants = [...existing.product.variants, candidate];
      continue;
    }
    const product = catalogProduct(source, context);
    products.set(source.id, { position: source.position, product: {
      ...product, departmentId: product.primaryCategoryId, shortDescription: product.shortDescription ?? undefined,
      brand: product.brand ?? undefined, addedOn: source.addedOn.toISOString().slice(0, 10),
      newArrival: source.newArrival, featured: source.featured, keywords: source.keywords,
      categoryIds: [product.primaryCategoryId, ...product.secondaryCategoryIds],
      variants: [candidate],
    } });
  }
  return [...products.values()].sort((left, right) => left.position - right.position || left.product.id.localeCompare(right.product.id))
    .map(({ product }) => product);
}
