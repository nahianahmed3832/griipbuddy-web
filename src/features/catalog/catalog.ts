export const collections = [
  { id: 'new-arrivals', label: 'New Arrivals', description: 'The latest additions to the edit.' },
  { id: 'best-sellers', label: 'Best Sellers', description: 'The pieces shoppers come back to.' },
  { id: 'trending', label: 'Trending Now', description: 'A closer look at what’s in the spotlight.' },
] as const;

export type CollectionId = typeof collections[number]['id'];
export type Market = {
  id: string;
  code: string;
  name: string;
  currency: string;
  locale: string;
  region: 'BD' | 'INTERNATIONAL';
  prefix: string;
  catalogCountry?: string;
};

export type Category = {
  id: string;
  slug: string;
  label: string;
  description?: string;
  image?: string;
  path: string[];
  children: Category[];
};

export type Money = { regular: number; sale?: number };
export type CatalogVariant = {
  id: string;
  sku: string;
  attributes: Record<string, string>;
  images: string[];
  price?: Money;
};

export type CatalogProduct = {
  id: string;
  slug: string;
  name: string;
  sku: string;
  category: string[];
  brand?: { id: string; name: string };
  description: string;
  images: string[];
  variants: CatalogVariant[];
  specifications: { title: string; values: string[] }[];
  tags: string[];
  labels: string[];
  createdAt?: string;
  sold?: number;
  availability?: Availability;
};

export type Availability = 'in' | 'out' | 'unknown';
export type Suggestion = { href: string; title: string; kind: 'Product' | 'Category' };

export function marketForSegment(markets: Market[], segment?: string) {
  const token = segment?.toLowerCase();
  return markets.find((market) => market.code.toLowerCase() === token || market.prefix.slice(1) === token);
}

export function marketHref(market: Market, path = '/') {
  return market.prefix + (market.prefix && path === '/' ? '' : path);
}

export function categoryHref(market: Market, path: string[]) {
  return marketHref(market, '/category/' + path.map(encodeURIComponent).join('/'));
}

export function productHref(market: Market, slug: string) {
  return marketHref(market, '/product/' + encodeURIComponent(slug));
}

export function formatMoney(amount: number, market: Market) {
  return new Intl.NumberFormat(market.locale, {
    style: 'currency',
    currency: market.currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : undefined,
  }).format(amount);
}

export function currentPrice(price: Money) {
  return price.sale ?? price.regular;
}

export function attribute(variant: CatalogVariant, name: string) {
  return Object.entries(variant.attributes).find(([key]) => key.toLowerCase() === name)?.[1];
}

export function productBadges(product: CatalogProduct) {
  const labels = new Set(product.labels.map((label) => label.toLowerCase().trim().replace(/[-_]+/g, ' ')));
  return [
    product.availability === 'out' && 'Out of Stock',
    product.variants.some((variant) => variant.price?.sale !== undefined) && 'Sale',
    (labels.has('best seller') || labels.has('bestseller')) && 'Best Seller',
    (labels.has('new') || labels.has('new arrival')) && 'New',
  ].filter((badge): badge is string => Boolean(badge));
}

export function flattenCategories(categories: Category[]): Category[] {
  return categories.flatMap((category) => [category, ...flattenCategories(category.children)]);
}

export function categoryAt(categories: Category[], path: string[]) {
  let matches = categories;
  let category: Category | undefined;
  for (const slug of path) {
    category = matches.find((entry) => entry.slug === slug);
    if (!category) return undefined;
    matches = category.children;
  }
  return category;
}

export function validSlug(value: string) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,179}$/u.test(value);
}
