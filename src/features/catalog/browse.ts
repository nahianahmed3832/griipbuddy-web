import { attribute, currentPrice, type CatalogProduct, type CatalogVariant, type CollectionId } from './catalog';

export const sortLabels = {
  relevance: 'Relevance', newest: 'Newest', popular: 'Popular', 'price-asc': 'Price: low to high', 'price-desc': 'Price: high to low',
} as const;

type Sort = keyof typeof sortLabels;
export type CatalogParams = Record<string, string | string[] | undefined>;
export type Filters = ReturnType<typeof parseFilters>;

function text(value: CatalogParams[string], limit = 100) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function amount(value: CatalogParams[string]) {
  const entry = text(value, 20);
  return /^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(entry) ? Number(entry) : undefined;
}

export function parseFilters(params: CatalogParams, fallback: Sort) {
  const sort = text(params.sort);
  const availability = text(params.availability);
  return {
    query: text(params.q), category: text(params.category, 180), brand: text(params.brand),
    size: text(params.size), color: text(params.color),
    min: amount(params.min), max: amount(params.max),
    availability: availability === 'in' || availability === 'out' ? availability : undefined,
    sort: (Object.hasOwn(sortLabels, sort) ? sort : fallback) as Sort,
    batch: Math.min(100000, Math.max(1, Number.parseInt(text(params.batch, 8), 10) || 1)),
    page: Math.min(1000, Math.max(1, Number.parseInt(text(params.page, 8), 10) || 1)),
  };
}

function normalized(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export function relevance(product: CatalogProduct, query: string, categoryLabel = '') {
  const clean = normalized(query);
  if (!clean) return 0;
  const name = normalized(product.name);
  const skus = [product.sku, ...product.variants.map((variant) => variant.sku)].map(normalized);
  const rest = normalized([
    product.slug, product.brand?.name, categoryLabel, product.category.join(' '), product.description, ...product.tags,
    ...product.variants.flatMap((variant) => Object.values(variant.attributes)),
  ].join(' '));
  const tokens = clean.split(/\s+/);
  if (!tokens.every((token) => name.includes(token) || rest.includes(token) || skus.some((sku) => sku.includes(token)))) return -1;
  if (skus.includes(clean) || name === clean) return 4;
  if (name.startsWith(clean)) return 3;
  if (name.includes(clean)) return 2;
  return 1;
}

export function inCategory(product: CatalogProduct, path: string[]) {
  return path.every((slug, index) => product.category[index] === slug);
}

export function inCollection(product: CatalogProduct, collection?: CollectionId) {
  if (collection === 'best-sellers') {
    return (product.sold ?? 0) > 0 || product.labels.some((label) => /^(best[ -_]?seller)$/i.test(label.trim()));
  }
  if (collection !== 'trending') return true;
  return [...product.labels, ...product.tags].some((label) => ['trending', 'trending now'].includes(normalized(label).replace(/[-_]+/g, ' ')));
}

export function matchingVariants(product: CatalogProduct, filters: Filters) {
  return product.variants.filter((variant) => {
    if (!variant.price) return false;
    const price = currentPrice(variant.price);
    return (!filters.size || normalized(attribute(variant, 'size') ?? '') === normalized(filters.size))
      && (!filters.color || normalized(attribute(variant, 'color') ?? attribute(variant, 'colour') ?? '') === normalized(filters.color))
      && (filters.min === undefined || price >= filters.min)
      && (filters.max === undefined || price <= filters.max);
  });
}

export function lowestPricedVariant(variants: CatalogVariant[]) {
  return variants.reduce<CatalogVariant | undefined>((lowest, variant) => (
    variant.price && (!lowest?.price || currentPrice(variant.price) < currentPrice(lowest.price)) ? variant : lowest
  ), undefined);
}

export function compareProducts(a: CatalogProduct, b: CatalogProduct, sort: Sort) {
  const recent = (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  const tie = recent || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (sort === 'popular') return (b.sold ?? 0) - (a.sold ?? 0) || tie;
  if (sort === 'price-asc' || sort === 'price-desc') {
    const ap = lowestPricedVariant(a.variants)?.price;
    const bp = lowestPricedVariant(b.variants)?.price;
    if (ap && bp) return (currentPrice(ap) - currentPrice(bp)) * (sort === 'price-asc' ? 1 : -1) || tie;
  }
  return tie;
}
