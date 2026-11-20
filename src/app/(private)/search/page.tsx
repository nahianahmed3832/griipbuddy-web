import type { Metadata } from "next";
import Link from "next/link";
import { BrowseUrlNormalization } from "@/components/browse-url-normalization";
import { ConnectedBrowseChips, ConnectedBrowseFilters, ConnectedBrowsePagination, ConnectedBrowseSort } from "@/components/connected-browse-controls";
import { ConnectedCatalogCards } from "@/components/connected-catalog-browse";
import { SearchResultsMeasurement } from "@/components/measurement-observers";
import { Breadcrumbs, EmptyState } from "@/components/store-ui";
import { localizedStorePath } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { browseRequestState, needsBrowseUrlNormalization } from "@/lib/catalog/browse-url-state";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { categoryBrowseControls, prepareCategoryBrowseQuery } from "@/lib/catalog/category-browse-query";
import { listCategoryPresentation } from "@/lib/catalog/category-presentation";
import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { CatalogApiError } from "@/lib/catalog/connected-public";
import type { SearchParams } from "@/lib/catalog/listing";
import { readSearchQuery, searchQueryMaxLength } from "@/lib/catalog/search-query";
import { reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { searchShops } from "@/lib/marketplace/data";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata: Metadata = { title: "Search", robots: { index: false, follow: true } };

type Market = Awaited<ReturnType<typeof currentMarket>>;

async function readSearch(query: string, raw: SearchParams, market: Market) {
  const category = typeof raw.category === "string" ? raw.category : typeof raw.department === "string" ? raw.department : undefined;
  const collection = typeof raw.collection === "string" ? raw.collection : undefined;
  const prepared = prepareCategoryBrowseQuery({ ...raw, q: query }, market, { category, collection });
  try {
    const listing = await listConnectedCatalog(prepared.params, {
      marketId: market.id, locale: market.locale, delivery: prepared.delivery,
    }, undefined, undefined, { browsePage: prepared.page, search: true, keepUnmatchedFacets: !prepared.changedMarket });
    if (!listing.browse) return { problem: "Results are temporarily unavailable. Try again.", retry: true };
    const controls = categoryBrowseControls(prepared, listing.browse);
    const filter = new URLSearchParams(controls.query);
    if (listing.categoryId) filter.set("category", listing.categoryId);
    if (listing.collectionId) filter.set("collection", listing.collectionId);
    return { listing, browse: listing.browse, prepared, controls, filter };
  } catch (error) {
    if (error instanceof CatalogApiError) {
      if (error.code === "catalog_scope_too_broad") return { problem: "Choose a category to narrow the search.", narrow: true };
      if (error.code === "category_not_found" || error.code === "collection_not_found") {
        const scope = error.code === "category_not_found" ? "category" : "collection";
        return { problem: `This search ${scope} is unavailable in your shopping market.` };
      }
      if (error.status === 400) return { problem: "Some search filters are invalid. Start again with the search term." };
    }
    reportFailure("search.results", undefined, error);
    return { problem: "Results are temporarily unavailable. Try again.", retry: true };
  }
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [market, params] = await Promise.all([currentMarket(), searchParams]);
  const query = readSearchQuery(params.q);
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const path = context.regional ? localizedStorePath("/search", market.id) : "/search";
  const searchHref = (href: string, values?: URLSearchParams) => catalogBrowseHref(href, context, values);
  const source = browseRequestState(params);
  const term = new URLSearchParams(query ? { q: query } : undefined);
  const reset = searchHref("/search", term);
  const startOver = searchHref("/search");
  const [result, shops] = await Promise.all([
    query ? readSearch(query, params, market) : null,
    query && marketplaceMode() && !firstPartyStoreMode() ? searchShops(query, market.id).catch(error => {
      reportFailure("search.shops", undefined, error);
      return [];
    }) : [],
  ]);
  const categories = result?.narrow ? (await listCategoryPresentation(market.id, market.locale).catch(error => {
    reportFailure("search.categories", undefined, error);
    return [];
  })).filter(category => category.visibleInNavigation && category.id !== params.category).slice(0, 8) : [];

  return <div className="shell inner-page listing-page connected-catalog">
    <Breadcrumbs items={[{ label: "Search" }]} />
    <header className="connected-catalog-heading">
      <h1 className="display-type">{query ? `Results for “${query}”` : "Search the store"}</h1>
    </header>
    {shops.length > 0 && <nav className="mp-search-shops connected-catalog-section" aria-label="Matching shops">
      <strong>Matching shops</strong>
      {shops.slice(0, 4).map(shop => <Link href={searchHref(`/shops/${encodeURIComponent(shop.slug)}`)} key={shop.id}>{shop.name}</Link>)}
      <Link href={searchHref("/shops", term)}>See all shops</Link>
    </nav>}
    {result?.listing && query ? <Results {...{ ...result, market, query, path, reset, startOver, source }} />
      : <EmptyState title={query === null ? "Check your search" : result ? "Search unavailable" : "What are you looking for?"}
        description={query === null ? `Enter one search term of up to ${searchQueryMaxLength} characters.` :
          result?.problem ?? "Search by product name, model, design or SKU using the search bar."}>
        {result?.retry && <a className="button button--primary"
          href={storefrontPath(searchHref("/search", new URLSearchParams(source)))}>Try again</a>}
        {result && !result.narrow && !result.retry &&
          <Link className="button button--outline" href={reset} prefetch={false}>Retry without filters</Link>}
        {query && categories.map(category => <Link key={category.id} className="button button--outline" prefetch={false}
          href={searchHref("/search", new URLSearchParams({ q: query, category: category.id }))}>{category.shortName}</Link>)}
        <Link className={result?.retry ? "button button--outline" : "button button--primary"}
          href={searchHref("/shop")} prefetch={false}>Browse all products</Link>
      </EmptyState>}
  </div>;
}

function Results({ listing, browse, prepared, controls, filter, market, query, path, reset, startOver, source }:
  Extract<Awaited<ReturnType<typeof readSearch>>, { listing: unknown }> & {
    market: Market; query: string; path: string; reset: string; startOver: string; source: string;
  }) {
  const controlsQuery = filter.toString();
  const scoped = Boolean(listing.categoryId || listing.collectionId);
  const active = controls.hasFilters || scoped;
  const clearScope = (name: "category" | "collection") => {
    const next = new URLSearchParams(filter);
    next.delete(name);
    return `${path}?${next}`;
  };
  const filters = { availability: filter.getAll("availability").includes("available") ? "in-stock" as const : undefined,
    min: filter.has("minMinor") ? Number(filter.get("minMinor")) : undefined,
    max: filter.has("maxMinor") ? Number(filter.get("maxMinor")) : undefined,
    offer: filter.get("sale") === "true" ? "sale" as const : undefined, sort: prepared.sort };
  return <div className="connected-browse-results">
    {needsBrowseUrlNormalization(source, browse.page, Boolean(controls.notice)) &&
      <BrowseUrlNormalization path={path} source={source} query={controlsQuery} page={browse.page} />}
    <SearchResultsMeasurement marketId={market.id} query={query} resultCount={listing.total}
      filterKey={JSON.stringify([controls.filterKey, listing.categoryId, listing.collectionId])}
      filterFields={controls.filterFields} scoped={scoped} sort={prepared.sort} filters={filters} />
    <ConnectedBrowseFilters path={path} query={controlsQuery} facets={browse.facets} price={browse.price} market={market} />
    <section className="connected-catalog-results" aria-labelledby="search-results-heading">
      <h2 id="search-results-heading" className="connected-results-title">Products</h2>
      {controls.notice && <p className="connected-browse-notice" role="status">{controls.notice}</p>}
      <div className="listing-toolbar">
        <p className="listing-results" aria-live="polite">{listing.total.toLocaleString(market.locale)} {listing.total === 1 ? "product" : "products"}</p>
        <ConnectedBrowseSort path={path} query={controlsQuery} />
      </div>
      <ConnectedBrowseChips path={path} query={controlsQuery} facets={browse.facets} market={market} clearLabel="Clear filters" />
      {listing.categoryId && <p className="listing-results"><Link href={clearScope("category")} prefetch={false}>Remove category filter</Link></p>}
      {listing.collectionId && <p className="listing-results"><Link href={clearScope("collection")} prefetch={false}>Remove collection filter</Link></p>}
      {listing.items.length ? <ConnectedCatalogCards products={listing.items} market={market} offset={(browse.page - 1) * prepared.pageSize} placement="search-results" />
        : <EmptyState title={active ? "No products match these filters" : "No products found"}
          description={active ? "Remove a filter or try another combination." : "Check the device generation or try an exact SKU, product name or design."}>
          <Link className="button button--outline" href={active ? reset : startOver} prefetch={false}>
            {active ? "Reset search filters" : "Start a new search"}
          </Link>
        </EmptyState>}
      <ConnectedBrowsePagination path={path} query={controlsQuery} page={browse.page} pageCount={browse.pageCount} label="Search result pages" />
    </section>
  </div>;
}
