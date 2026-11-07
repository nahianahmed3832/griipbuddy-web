import type { MetadataRoute } from 'next';
import { catalogNavigation, catalogProducts, mapLimited } from '@/features/catalog/data';
import { categoryHref, collections, flattenCategories, marketHref, productHref } from '@/features/catalog/catalog';
import { discoveryLinks } from '@/features/discovery/contracts';
import { canonicalOrigin } from '@/features/catalog/seo';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = canonicalOrigin();
  if (!origin) return [];
  const { markets, categories } = await catalogNavigation();
  const paths = await mapLimited(markets.filter((market) => market.code !== 'INTL'), 2, async (market) => [
    marketHref(market), marketHref(market, '/products'),
    ...discoveryLinks.map(({ path }) => marketHref(market, path)),
    ...flattenCategories(categories).map((category) => categoryHref(market, category.path)),
    ...collections.map((collection) => marketHref(market, '/collections/' + collection.id)),
    ...(await catalogProducts(market)).map((product) => productHref(market, product.slug)),
  ]);
  return [...new Set(paths.flat())].map((path) => ({ url: origin + path }));
}
