import type { Metadata } from "next";
import Link from "next/link";
import { ConnectedBrowseChips, ConnectedBrowseFilters, ConnectedBrowsePagination, ConnectedBrowseSort } from "@/components/connected-browse-controls";
import { ConnectedCatalogCards } from "@/components/connected-catalog-browse";
import { SearchResultsMeasurement } from "@/components/measurement-observers";
import { Breadcrumbs, EmptyState } from "@/components/store-ui";
import { localizedStorePath } from "@/config/regional-path";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { categoryBrowseControls, prepareCategoryBrowseQuery } from "@/lib/catalog/category-browse-query";
import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { CatalogApiError } from "@/lib/catalog/connected-public";
import { readQuery, type SearchParams } from "@/lib/catalog/listing";
import { reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { searchShops } from "@/lib/marketplace/data";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata: Metadata = { title: "Search", robots: { index: false, follow: true } };

type Market = Awaited<ReturnType<typeof currentMarket>>;
const browsePageSize = 24;

async function readSearch(raw: SearchParams, market: Market) {
  const category = typeof raw.category === "string" ? raw.category : typeof raw.department === "string" ? raw.department : undefined;
  const prepared = prepareCategoryBrowseQuery({ ...raw, q: readQuery(raw) }, market, { category });
  if (!prepared.params.has("q")) return { problem: "Enter a valid product name, model, design or SKU." };
  try {
    const listing = await listConnectedCatalog(prepared.params, {
      marketId: market.id, locale: market.locale, delivery: prepared.delivery,
    }, undefined, undefined, { browsePage: prepared.page, search: true });
    if (!listing.browse) return { problem: "Results are temporarily unavailable. Try again." };
    const controls = categoryBrowseControls(prepared, listing.browse);
    const filter = new URLSearchParams(controls.query);
    if (listing.categoryId) filter.set("category", listing.categoryId);
    return { listing, browse: listing.browse, prepared, controls, filter };
  } catch (error) {
    if (error instanceof CatalogApiError) {
      if (error.code === "catalog_scope_too_broad") return { problem: "Choose a category to narrow the search." };
      if (error.code === "category_not_found") return { problem: "This search category is unavailable in your shopping market." };
      if (error.status === 400) return { problem: "Some search filters are invalid. Start again with the search term." };
    }
    reportFailure("search.results", undefined, error);
    return { problem: "Results are temporarily unavailable. Try again." };
  }
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [market, params] = await Promise.all([currentMarket(), searchParams]);
  const query = readQuery(params);
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const path = context.regional ? localizedStorePath("/search", market.id) : "/search";
  const searchHref = (href: string, values?: URLSearchParams) => catalogBrowseHref(href, context, values);
  const reset = searchHref("/search", new URLSearchParams({ q: query }));
  const startOver = searchHref("/search");
  const [result, shops] = await Promise.all([
    query ? readSearch(params, market) : null,
    query && marketplaceMode() && !firstPartyStoreMode() ? searchShops(query, market.id).catch(error => {
      reportFailure("search.shops", undefined, error);
      return [];
    }) : [],
  ]);

  return <div className="shell inner-page listing-page connected-catalog">
    <Breadcrumbs items={[{ label: "Search" }]} />
    <header className="connected-catalog-heading">
      <h1 className="display-type">{query ? `Results for “${query}”` : "Search the store"}</h1>
    </header>
    {shops.length > 0 && <nav className="mp-search-shops connected-catalog-section" aria-label="Matching shops">
      <strong>Matching shops</strong>
      {shops.slice(0, 4).map(shop => <Link href={searchHref(`/shops/${encodeURIComponent(shop.slug)}`)} key={shop.id}>{shop.name}</Link>)}
      <Link href={searchHref("/shops", new URLSearchParams({ q: query }))}>See all shops</Link>
    </nav>}
    {result?.listing ? <Results {...{ ...result, market, query, path, reset, startOver }} />
      : <EmptyState title={result ? "Search unavailable" : "What are you looking for?"} description={result?.problem ??
        "Search by product name, model, design or SKU using the search bar."}>
        {result && <Link className="button button--outline" href={reset} prefetch={false}>Retry without filters</Link>}
        <Link className="button button--primary" href={searchHref("/shop")} prefetch={false}>Browse all products</Link>
      </EmptyState>}
  </div>;
}

function Results({ listing, browse, prepared, controls, filter, market, query, path, reset, startOver }:
  Extract<Awaited<ReturnType<typeof readSearch>>, { listing: unknown }> & {
    market: Market; query: string; path: string; reset: string; startOver: string;
  }) {
  const controlsQuery = filter.toString();
  const active = controls.hasFilters || Boolean(listing.categoryId);
  const filters = { availability: filter.getAll("availability").includes("available") ? "in-stock" as const : undefined,
    min: filter.has("minMinor") ? Number(filter.get("minMinor")) : undefined,
    max: filter.has("maxMinor") ? Number(filter.get("maxMinor")) : undefined,
    offer: filter.get("sale") === "true" ? "sale" as const : undefined, sort: prepared.sort };
  return <div className="connected-browse-results">
    <SearchResultsMeasurement marketId={market.id} query={query} resultCount={listing.total}
      filterKey={`${controls.filterKey}:${listing.categoryId ?? ""}`} filterFields={controls.filterFields} sort={prepared.sort} filters={filters} />
    <ConnectedBrowseFilters path={path} query={controlsQuery} facets={browse.facets} price={browse.price} market={market}
      normalizePage={controls.notice || prepared.changedMarket || prepared.page !== browse.page ? browse.page : undefined} />
    <section className="connected-catalog-results" aria-labelledby="search-results-heading">
      <h2 id="search-results-heading" className="connected-results-title">Products</h2>
      {controls.notice && <p className="connected-browse-notice" role="status">{controls.notice}</p>}
      <div className="listing-toolbar">
        <p className="listing-results" aria-live="polite">{listing.total.toLocaleString(market.locale)} {listing.total === 1 ? "product" : "products"}</p>
        <ConnectedBrowseSort path={path} query={controlsQuery} />
      </div>
      <ConnectedBrowseChips path={path} query={controlsQuery} facets={browse.facets} market={market} clearLabel="Clear filters" />
      {listing.categoryId && <p className="listing-results"><Link href={reset} prefetch={false}>Remove category filter</Link></p>}
      {listing.items.length ? <ConnectedCatalogCards products={listing.items} market={market} offset={(browse.page - 1) * browsePageSize} placement="search-results" />
        : <EmptyState title={active ? "No products match these filters" : "No products found"}
          description={active ? "Remove a filter or try another combination." : "Try another name, model, design or SKU."}>
          <Link className="button button--outline" href={active ? reset : startOver} prefetch={false}>
            {active ? "Reset search filters" : "Start a new search"}
          </Link>
        </EmptyState>}
      <ConnectedBrowsePagination path={path} query={controlsQuery} page={browse.page} pageCount={browse.pageCount} label="Search result pages" />
    </section>
  </div>;
}
