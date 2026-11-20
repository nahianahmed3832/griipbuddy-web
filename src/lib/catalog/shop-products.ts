import type { Market } from "../../config/markets.ts";
import { connectedOfferScope } from "../commerce/market-offers.ts";
import { inventoryPoolScopeKey, marketRoutedInventory } from "../commerce/physical-inventory.ts";
import { getDb } from "../db/client.ts";
import { catalogProduct, catalogVariantInclude, catalogVariants } from "./connected-public.ts";
import { catalog } from "./repository.ts";
import { searchProducts } from "./search.ts";
import type { CatalogProduct, Department, ListedVariant } from "./types.ts";

export async function shopProducts(shop: { id: string; slug: string; name: string }, market: Market, query: string, departments: readonly Department[]) {
  const db = getDb();
  const marketId = market.id;
  const context = { marketId, locale: market.locale };
  const include = catalogVariantInclude(context);
  const scope = connectedOfferScope(marketId);
  const [legacy, rows] = await Promise.all([
    catalog.listProducts({ marketId, shopId: shop.id }),
    db.variant.findMany({ where: { offers: { some: { ...scope,
      identity: { is: { ...scope.identity?.is, sellerId: shop.id } } } } },
    include: { ...include, product: { select: { ...include.product.select, featured: true, newArrival: true, demo: true } } },
    orderBy: [{ product: { position: "asc" } }, { productId: "asc" }, { position: "asc" }, { id: "asc" }] }),
  ]);
  const sources = new Map(rows.map(row => [row.id, row.product]));
  const now = new Date();
  const variants = await catalogVariants(rows, context, db, now);
  const availability = await marketRoutedInventory(db, marketId, variants.filter(row => row.offer.eligible)
    .map(({ id, offer }) => ({ variantId: id, ownerId: offer.sellerId })));
  const result = new Map(legacy.map(product => [product.id, product]));
  for (const row of variants) {
    const source = sources.get(row.id);
    if (!source || !row.offer.id || row.offer.sellerId !== shop.id) continue;
    const product = catalogProduct(source, context);
    const stock = availability.get(inventoryPoolScopeKey({ variantId: row.id, ownerId: shop.id })) ?? 0;
    const offer: ListedVariant["offer"] = row.offer.eligible ? {
      id: row.offer.id, variantId: row.id, marketId, currency: row.offer.currency,
      amountMinor: row.offer.amountMinor, regularMinor: row.offer.regularMinor, stock,
      ...(row.offer.promotionEndsAt && { promotion: { endsAt: row.offer.promotionEndsAt,
        remainingSeconds: Math.ceil((Date.parse(row.offer.promotionEndsAt) - +now) / 1000) } }),
    } : null;
    const variant: ListedVariant = { id: row.id, sku: row.sku, gtin: row.gtin ?? undefined, mpn: row.mpn ?? undefined,
      options: Object.fromEntries(row.options.map(option => [option.label, option.valueLabel])), image: row.image ?? undefined, offer };
    const current = result.get(source.id);
    const item: CatalogProduct = current ?? { ...product, departmentId: product.primaryCategoryId,
      brand: product.brand ?? undefined, shortDescription: product.shortDescription ?? undefined, shop,
      addedOn: source.addedOn.toISOString().slice(0, 10), keywords: source.keywords,
      featured: source.featured, newArrival: source.newArrival, demo: source.demo, variants: [] };
    result.set(source.id, { ...item, variants: [...item.variants, variant] });
  }
  const products = [...result.values()];
  return query ? searchProducts(products, new Map(departments.map(row => [row.id, row])), query) : products;
}
