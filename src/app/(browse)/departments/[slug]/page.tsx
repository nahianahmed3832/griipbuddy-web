import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ConnectedCatalogBrowse } from "@/components/connected-catalog-browse";
import { CatalogJsonLd } from "@/components/catalog-json-ld";
import type { MarketId } from "@/config/markets";
import { catalogAbsoluteUrl, catalogRobots, catalogSeoLocales, catalogSeoPath, hasBrowseFilters } from "@/lib/catalog/catalog-seo";
import { connectedCategoryCollections, connectedCategoryDetail } from "@/lib/catalog/connected-navigation";
import type { SearchParams } from "@/lib/catalog/listing";
import { breadcrumbMetadata } from "@/lib/catalog/product-metadata";
import { getDb } from "@/lib/db/client";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl } from "@/lib/release-config";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };
const findCategory = cache((slug: string, marketId: MarketId, locale: string) => connectedCategoryDetail(slug, { marketId, locale }));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, market, query] = await Promise.all([params, currentMarket(), searchParams]);
  const data = await findCategory(slug, market.id, market.locale);
  if (!data) return { title: "Category unavailable", robots: { index: false, follow: true } };
  const { category } = data;
  const robots = catalogRobots(market, hasBrowseFilters(query));
  const fields = { title: category.contentLocale ? category.name : category.seoTitle,
    description: category.contentLocale ? category.description : category.seoDescription, robots };
  if (robots?.follow === false) return fields;
  const { id, defaultLocale } = market;
  let locale = market.locale;
  let canonicalSlug = category.localizedSlug;
  if (locale !== defaultLocale) {
    const translations = await getDb().departmentTranslation.findMany({ where: { departmentId: category.id }, select: { locale: true } });
    if (!catalogSeoLocales(id, translations.map(row => row.locale)).includes(locale)) {
      locale = defaultLocale;
      canonicalSlug = (await findCategory(category.id, id, locale))?.category.localizedSlug ?? category.slug;
    }
  }
  return { ...fields, alternates: { canonical: canonicalUrl(catalogSeoPath(`/departments/${encodeURIComponent(canonicalSlug)}`, { id, locale })) } };
}

export default async function DepartmentPage({ params, searchParams }: Props) {
  const [{ slug }, market, raw] = await Promise.all([params, currentMarket(), searchParams]);
  const data = await findCategory(slug, market.id, market.locale);
  if (!data) notFound();
  const collections = data.category.kind === "DEPARTMENT" || data.category.kind === null && data.category.parentId === null
    ? await connectedCategoryCollections([data.category.id, ...data.descendantCategoryIds], { marketId: market.id, locale: market.locale }) : [];
  const href = (slug: string) => catalogAbsoluteUrl(`/departments/${encodeURIComponent(slug)}`, market);
  const crumbs = data.ancestors.map(category => ({ label: category.shortName, href: href(category.localizedSlug) }));
  return <>
    <CatalogJsonLd data={breadcrumbMetadata(crumbs, { label: data.category.name, href: href(data.category.localizedSlug) })} />
    <ConnectedCatalogBrowse destination={{ type: "category", data, collections }} market={market} raw={raw} />
  </>;
}
