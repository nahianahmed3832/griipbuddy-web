import 'server-only';
import { cache } from 'react';
import { fixturesEnabled, hostedCatalogPreview } from '@/features/public-build';
import { withInternational } from '@/features/markets/resolve';
import { apiBrands, apiCategory, apiConfigured, apiMarkets, apiProduct, CatalogError, catalogGet, objectId, record, rows } from './api';
import { flattenCategories, validSlug, type Availability, type CatalogProduct, type CatalogVariant, type Market } from './catalog';
import { syntheticStock } from '@/features/checkout/ledger';
import { fixtureCategories, fixtureMarkets, fixtureProducts, fixtureStock } from './fixtures';

const pageSize = 100;
const maxProducts = 1500;
const references = { reference: true };

export const catalogNavigation = cache(async () => {
  if (!apiConfigured()) return { markets: withInternational(fixturesEnabled() ? fixtureMarkets : []), categories: fixturesEnabled() ? fixtureCategories : [] };

  const [countries, taxonomy] = await Promise.all([
    catalogGet('/country/all', undefined, references),
    catalogGet('/category/published/all', undefined, references),
  ]);
  const categories = (await Promise.all(rows(record(taxonomy).data).map(async (entry) => {
    const category = apiCategory(entry);
    if (!category || category.children.length) return category;

    // Legacy categories can have children linked only from the child record.
    const children = await catalogGet('/sub-category/by-category/published/' + category.id, undefined, references);
    return { ...category, children: rows(children).flatMap((child) => apiCategory(child, category.path) ?? []) };
  }))).flatMap((category) => category ?? []);

  return { markets: withInternational(apiMarkets(countries)), categories };
});

const catalogReferences = cache(async () => {
  const [navigation, brands] = await Promise.all([
    catalogNavigation(),
    catalogGet('/brand/all', undefined, references),
  ]);
  return {
    taxonomy: new Map(flattenCategories(navigation.categories).map((category) => [category.id, category])),
    brands: apiBrands(brands),
  };
});

async function productPage(region: Market['region'], page: number, popularity: boolean, root?: string, query?: string) {
  const params = new URLSearchParams({ region, page: String(page), limit: String(pageSize) });
  if (root && !popularity) params.set('category', root);
  // The recovered API interprets q as a regular expression. Send a literal.
  if (query && !popularity) params.set('q', query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const payload = record(await catalogGet(popularity ? '/product/top-sale' : '/product', params, { reference: hostedCatalogPreview() && !query }));
  const total = record(payload.meta).total;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0 || !Array.isArray(payload.products)) {
    throw new CatalogError('Unexpected catalog listing response.');
  }
  return { total, products: payload.products as unknown[] };
}

const initialPage = cache((region: Market['region'], popularity: boolean, root?: string) =>
  productPage(region, 1, popularity, root));

async function normalizeProducts(products: unknown[], market: Market) {
  const { taxonomy, brands } = await catalogReferences();
  const normalized = products.flatMap((row) => apiProduct(row, record(row).variants, market, taxonomy, brands) ?? []);
  return [...new Map(normalized.filter(hasPrice).map((product) => [product.id, product])).values()];
}

export async function catalogSample(market: Market, popularity = false, root?: string) {
  if (!market.id || !apiConfigured()) return catalogProducts(market, popularity, root);
  const list = await initialPage(market.region, popularity, popularity ? undefined : root);
  return normalizeProducts(list.products, market);
}

export const catalogBrowse = cache(async (market: Market, popularity = false, root?: string, requestedBatch = 1, query?: string) => {
  if (!market.id) return { products: [] as CatalogProduct[] };
  if (!apiConfigured()) return { products: fixturesEnabled() ? fixtureProducts(market).filter(hasPrice) : [] };

  const category = popularity ? undefined : root;
  const first = await initialPage(market.region, popularity, category);
  if (first.total > maxProducts) {
    const firstMatch = query && !popularity ? await productPage(market.region, 1, false, category, query) : first;
    const batches = Math.max(1, Math.ceil(firstMatch.total / pageSize));
    const batch = Math.min(requestedBatch, batches);
    const window = batch === 1 ? firstMatch : await productPage(market.region, batch, popularity, category, query);
    return { products: await normalizeProducts(window.products, market), batch, batches };
  }

  const pages = Array.from({ length: Math.max(0, Math.ceil(first.total / pageSize) - 1) }, (_, i) => i + 2);
  const rest = await mapLimited(pages, 3, (page) => productPage(market.region, page, popularity, category));
  return { products: await normalizeProducts(first.products.concat(...rest.map((page) => page.products)), market) };
});

export const catalogProducts = cache(async (market: Market, popularity = false, root?: string) =>
  (await catalogBrowse(market, popularity, root)).products);

export const catalogProduct = cache(async (market: Market, slug: string) => {
  if (!market.id || !validSlug(slug)) return undefined;
  if (!apiConfigured()) return fixturesEnabled() ? fixtureProducts(market).find((product) => product.slug === slug) : undefined;
  const payload = record(await catalogGet('/product/slug/' + encodeURIComponent(slug), undefined, { missing: true }));
  if (!payload.product) return undefined;
  const { taxonomy, brands } = await catalogReferences();
  return apiProduct(payload.product, payload.variants, market, taxonomy, brands);
});

function hasPrice(product: CatalogProduct) {
  return product.variants.some((variant) => variant.price);
}

export const variantStock = cache(async (product: CatalogProduct, variant: CatalogVariant, merchandising = false) => {
  if (!variant.price) return null;
  if (!apiConfigured()) return fixturesEnabled() ? syntheticStock(product.id, variant.id, fixtureStock(product, variant.id)) : null;
  if (!objectId(product.id) || !objectId(variant.id)) return null;

  try {
    const data = record(await catalogGet('/stocks/' + product.id + '/' + variant.id, undefined, {
      missing: true, reference: merchandising && hostedCatalogPreview(),
    }));
    const amount = data.totalAvailableQuantity;
    return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
  } catch {
    return null;
  }
});

export async function availableMerchandise(products: CatalogProduct[]) {
  const checked = await mapLimited(products, 5, async (product) => {
    for (const variant of product.variants.filter((entry) => entry.price).slice(0, 5)) {
      const stock = await variantStock(product, variant, true);
      if (stock && stock > 0) return { ...product, variants: [variant], availability: 'in' as const };
    }
  });
  return checked.flatMap((product) => product ?? []);
}

export async function productAvailability(product: CatalogProduct, limit = 8): Promise<Availability> {
  const variants = product.variants.filter((variant) => variant.price);
  let unknown = variants.length > limit;
  for (const variant of variants.slice(0, limit)) {
    const stock = await variantStock(product, variant, true);
    if (stock === null) unknown = true;
    else if (stock > 0) return 'in';
  }
  return unknown || !variants.length ? 'unknown' : 'out';
}

export async function withAvailability(products: CatalogProduct[]) {
  return mapLimited(products, 8, async (product) => ({ ...product, availability: await productAvailability(product) }));
}

export async function mapLimited<T, U>(input: T[], concurrency: number, apply: (value: T) => Promise<U>) {
  const output: U[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (next < input.length) {
      const index = next++;
      output[index] = await apply(input[index]);
    }
  }));
  return output;
}
