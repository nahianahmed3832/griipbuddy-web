import { marketIds, type MarketId } from "../../config/markets.ts";
import { localizedStorePath } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { canonicalUrl, hybridDemoMode, storefrontIndexingEnabled } from "../release-config.ts";
import { catalogLocaleChain } from "./category-locale.ts";
import { listCategoryPresentation } from "./category-presentation.ts";
import { publicCollectionScope } from "./collection-selection.ts";
import { catalogVariantWhere } from "./connected-public.ts";

type SeoContext = { id: MarketId; locale: string };

export function catalogSeoPath(path: string, { id, locale }: SeoContext, regional = false) {
  return `${regional ? localizedStorePath(path, id) : path}?${new URLSearchParams({ market: id, lang: locale })}`;
}

export function indexableMarket(marketId: MarketId) {
  const { status } = marketConfiguration(marketId);
  return status === "active" || status === "paused";
}

export function catalogAbsoluteUrl(path: string, context: SeoContext) {
  const published = canonicalUrl(catalogSeoPath(path, context));
  if (published) return published;
  const origin = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3100";
  return new URL(storefrontPath(catalogSeoPath(path, context, hybridDemoMode())), origin).href;
}

export function catalogRobots(context: SeoContext, filtered = false) {
  if (!storefrontIndexingEnabled() || !indexableMarket(context.id)) return { index: false, follow: false };
  return filtered ? { index: false, follow: true } : undefined;
}

export function hasBrowseFilters(params: Record<string, string | string[] | undefined>) {
  return Object.keys(params).some(key => key !== "market" && key !== "lang");
}

function contentSource(locales: readonly string[], locale: string) {
  return catalogLocaleChain(locale).find(tag => locales.includes(tag));
}

export function catalogSeoLocales(marketId: MarketId, localized: readonly string[]) {
  const { defaultLocale, languages } = marketConfiguration(marketId);
  const emitted = new Set([contentSource(localized, defaultLocale)]);
  return [defaultLocale, ...languages.filter(locale => {
    const source = contentSource(localized, locale);
    if (locale === defaultLocale || !source || emitted.has(source)) return false;
    emitted.add(source);
    return true;
  })];
}

export async function productSeoAlternates(product: { id: string; slug: string }, market: SeoContext, db: DbReader = getDb()) {
  if (catalogRobots(market)) return undefined;
  const context = marketIds.filter(indexableMarket);
  const [translations, visibility] = await Promise.all([
    db.productTranslation.findMany({ where: { productId: product.id }, select: { locale: true } }),
    Promise.all(context.map(id => db.variant.findFirst({
      where: { productId: product.id, ...catalogVariantWhere(id) }, select: { id: true },
    }))),
  ]);
  const path = `/products/${encodeURIComponent(product.slug)}`;
  const locales = translations.map(row => row.locale);
  const options = context.flatMap((id, index) => visibility[index] ? catalogSeoLocales(id, locales).map(locale => ({ id, locale })) : []);
  const current = options.find(item => item.id === market.id && item.locale === market.locale) ??
    { id: market.id, locale: marketConfiguration(market.id).defaultLocale };
  const canonical = canonicalUrl(catalogSeoPath(path, current));
  const unique = new Set(options.map(item => item.locale));
  const languages = unique.size > 1 && unique.size === options.length ? Object.fromEntries(
    options.map(item => [item.locale, canonicalUrl(catalogSeoPath(path, item))!]),
  ) : undefined;
  return { canonical, ...(languages && { languages }) };
}

export type CatalogSitemapMarket = { id: MarketId; locales: readonly string[] };

export async function catalogSitemapPaths(db: DbReader, markets: readonly CatalogSitemapMarket[]) {
  const byMarket = await Promise.all(markets.map(async ({ id, locales }) => {
    if (!locales.length) return [];
    const [products, collections, categoryRows] = await Promise.all([
      db.product.findMany({
        where: { demo: false, migratedFromSlug: null, variants: { some: catalogVariantWhere(id) } },
        select: { slug: true, translations: { select: { locale: true } } },
        orderBy: [{ slug: "asc" }], take: 50_001,
      }),
      db.collection.findMany({ where: publicCollectionScope(id), select: { slug: true }, orderBy: [{ slug: "asc" }] }),
      db.departmentTranslation.findMany({ select: { departmentId: true, locale: true } }),
    ]);
    const categories = new Map<string, string[]>();
    for (const row of categoryRows) {
      const current = categories.get(row.departmentId) ?? [];
      current.push(row.locale);
      categories.set(row.departmentId, current);
    }
    const paths = products.flatMap(product => catalogSeoLocales(id, product.translations.map(row => row.locale))
      .filter(locale => locales.includes(locale))
      .map(locale => catalogSeoPath(`/products/${encodeURIComponent(product.slug)}`, { id, locale })));
    for (const locale of locales) {
      const presented = await listCategoryPresentation(id, locale, db);
      for (const category of presented) {
        if (catalogSeoLocales(id, categories.get(category.id) ?? []).includes(locale)) {
          paths.push(catalogSeoPath(`/departments/${encodeURIComponent(category.localizedSlug)}`, { id, locale }));
        }
      }
    }
    return [...paths, ...collections.map(({ slug }) =>
      catalogSeoPath(`/collections/${encodeURIComponent(slug)}`, { id, locale: locales[0] }))];
  }));
  return byMarket.flat();
}

export function sitemapMarkets() {
  if (!storefrontIndexingEnabled()) return [];
  return marketIds.filter(indexableMarket).map(id => {
    const { languages, defaultLocale } = marketConfiguration(id);
    return { id, locales: [defaultLocale, ...languages.filter(locale => locale !== defaultLocale)] };
  });
}
