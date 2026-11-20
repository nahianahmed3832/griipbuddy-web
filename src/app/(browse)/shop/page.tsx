import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CatalogMarketFallback, ConnectedCatalogBrowse } from "@/components/connected-catalog-browse";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { catalogRobots, hasBrowseFilters } from "@/lib/catalog/catalog-seo";
import { connectedCategoryTree, resolveConnectedCategory } from "@/lib/catalog/connected-navigation";
import type { SearchParams } from "@/lib/catalog/listing";
import { getDb } from "@/lib/db/client";
import { currentMarket } from "@/lib/market-server";
import { sellerVisibility } from "@/lib/marketplace/market-grants";
import { canonicalUrl, firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const [market, query] = await Promise.all([currentMarket(), searchParams]);
  return { title: "Shop all", robots: catalogRobots(market, hasBrowseFilters(query)), alternates: { canonical: canonicalUrl("/shop") } };
}

function forwardedFilters(raw: SearchParams, omit: string[]) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || omit.includes(key)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry);
  }
  return params;
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [market, raw] = await Promise.all([currentMarket(), searchParams]);
  const missing = raw.catalogUnavailable;
  if (missing === "category" || missing === "collection" || missing === "shop") {
    return <CatalogMarketFallback market={market} missing={missing} />;
  }

  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  if (typeof raw.shop === "string" && raw.shop && marketplaceMode() && !firstPartyStoreMode()) {
    const shop = await getDb().marketplaceShop.findFirst({ where: { slug: raw.shop, ...sellerVisibility(market.id) }, select: { slug: true } });
    if (!shop) return <CatalogMarketFallback market={market} missing="shop" />;
    redirect(catalogBrowseHref(`/shops/${encodeURIComponent(shop.slug)}`, context, forwardedFilters(raw, ["shop"])));
  }

  const reference = typeof raw.category === "string" ? raw.category : typeof raw.department === "string" ? raw.department : "";
  if (reference) {
    const result = await resolveConnectedCategory(reference, market.id, market.locale);
    if (!result) return <CatalogMarketFallback market={market} missing="category" />;
    redirect(catalogBrowseHref(`/departments/${encodeURIComponent(result.category.localizedSlug)}`, context,
      forwardedFilters(raw, ["category", "department"])));
  }
  const { categories } = await connectedCategoryTree({ marketId: market.id, locale: market.locale });
  return <ConnectedCatalogBrowse destination={{ type: "shop", categories }} market={market} raw={raw} />;
}
