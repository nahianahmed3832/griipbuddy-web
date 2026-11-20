import Form from "next/form";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Market } from "@/config/markets";
import { listingView, sortOptions, type SearchParams } from "@/lib/catalog/listing";
import { cardActivity } from "@/lib/catalog/card-activity";
import type { CatalogProduct, Department } from "@/lib/catalog/types";
import { ProductGrid } from "./product-grid";
import { Breadcrumbs, EmptyState } from "./store-ui";
import { MarketplaceFilters } from "./marketplace/filters";
import { ListingMeasurement } from "./measurement-observers";
import { marketplaceMode } from "@/lib/release-config";

type View = ReturnType<typeof listingView>;
type ListingControls = { path: string; query?: string; view: View };

function ListingFilters({ path, query, view }: ListingControls) {
  return (
    <Form action={path} className="listing-filters" aria-labelledby="filters-heading">
      {query && <input type="hidden" name="q" value={query} />}
      <input type="hidden" name="sort" value={view.sort} />
      <h2 id="filters-heading">Filters</h2>
      {view.departmentChoices.length > 1 && (
        <label>Department
          <select name="department" defaultValue={view.department}>
            <option value="">All departments</option>
            {view.departmentChoices.map((department) => <option key={department.id} value={department.slug}>{department.shortName}</option>)}
          </select>
        </label>
      )}
      {view.colors.length > 1 && (
        <label>Color
          <select name="color" defaultValue={view.color}>
            <option value="">All colors</option>
            {view.colors.map((color) => <option key={color} value={color}>{color}</option>)}
          </select>
        </label>
      )}
      <label>Availability
        <select name="availability" defaultValue={view.inStock ? "in-stock" : ""}>
          <option value="">All items</option>
          <option value="in-stock">In stock</option>
        </select>
      </label>
      <button className="button button--outline" type="submit">Apply filters</button>
    </Form>
  );
}

function ListingSort({ path, query, view }: ListingControls) {
  return (
    <Form action={path} className="listing-sort" aria-label="Sort products">
      {query && <input type="hidden" name="q" value={query} />}
      {view.department && <input type="hidden" name="department" value={view.department} />}
      {view.color && <input type="hidden" name="color" value={view.color} />}
      {view.inStock && <input type="hidden" name="availability" value="in-stock" />}
      <label>
        <span>Sort by</span>
        <select name="sort" defaultValue={view.sort}>
          {sortOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <button className="button button--outline" type="submit">Apply sort</button>
    </Form>
  );
}

export async function ListingPage({
  path, title, description, market, departments, products, params, departmentPage, childDepartments, parentDepartment, query, newest = false,
}: {
  path: string;
  title: string;
  description?: string;
  market: Market;
  departments: readonly Department[];
  products: readonly CatalogProduct[];
  params: SearchParams;
  departmentPage?: boolean;
  childDepartments?: readonly Department[];
  parentDepartment?: Department;
  query?: string;
  newest?: boolean;
}) {
  const marketplace = marketplaceMode();
  const view = listingView(products, departments, params, departmentPage, newest ? "newest" : "recommended",
    marketplace ? market.minorDigits : undefined, marketplace);
  const resetHref = query ? `${path}?q=${encodeURIComponent(query)}` : path;
  const hasFilters = products.length > 0;
  const filterKey = [path, query, view.department, view.color, view.device, view.inStock, view.min, view.max, view.sale, view.shop].join(":");
  const pageSize = 24;
  const pageCount = Math.max(1, Math.ceil(view.cards.length / pageSize));
  const requestedPage = typeof params.page === "string" && /^\d{1,5}$/.test(params.page) ? Number(params.page) : 1;
  const page = Math.min(pageCount, Math.max(1, requestedPage));
  const offset = (page - 1) * pageSize;
  const cards = view.cards.slice(offset, page * pageSize);
  const placement = path === "/search" ? "search-results" : departmentPage ? "department" : path.startsWith("/collections/")
    ? "collection" : path.startsWith("/shops/") ? "shop-listings" : path === "/gifts" ? "gift-listings" : "shop";
  const filters = {
    department: view.department || undefined, color: view.color || undefined, device: view.device || undefined,
    availability: view.inStock ? "in-stock" as const : undefined, offer: view.sale ? "sale" as const : undefined,
    min: view.min ? Math.round(Number(view.min) * 10 ** market.minorDigits) : undefined,
    max: view.max ? Math.round(Number(view.max) * 10 ** market.minorDigits) : undefined,
    shop: view.shop || undefined, sort: view.sort,
  };
  const activity = marketplace ? await cardActivity(market.id, cards.map(card => card.id)) : undefined;

  function pageHref(target: number) {
    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (view.department) search.set("department", view.department);
    if (view.color) search.set("color", view.color);
    if (view.device) search.set("device", view.device);
    if (view.inStock) search.set("availability", "in-stock");
    if (view.min) search.set("min", view.min);
    if (view.max) search.set("max", view.max);
    if (view.sale) search.set("offer", "sale");
    if (view.shop) search.set("shop", view.shop);
    if (typeof params.sort === "string") search.set("sort", view.sort);
    if (target > 1) search.set("page", String(target));
    const suffix = search.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  return (
    <div className="shell inner-page listing-page">
      <ListingMeasurement marketId={market.id} {...{ placement, query, filters }} resultCount={view.cards.length} active={view.active} />
      <Breadcrumbs items={[
        ...(parentDepartment ? [{ label: parentDepartment.shortName, href: `/departments/${parentDepartment.slug}` }] : []),
        { label: query === undefined ? title : "Search" },
      ]} />
      <div className="listing-intro">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {childDepartments && childDepartments.length > 0 &&
        <nav className="mp-subcategory-links" aria-label="Subcategories">
          {childDepartments.map(({ id, shortName, slug }) => <Link key={id} href={`/departments/${slug}`}>{shortName}</Link>)}
        </nav>}
      {query === "" ? (
        <EmptyState title="What are you looking for?" description="Search by product, department, or a detail like “cotton” or “USB-C” using the search bar.">
          <Link className="button button--primary" href="/shop">Browse all products <ArrowRight aria-hidden="true" size={17} /></Link>
        </EmptyState>
      ) : (
        <div className={hasFilters && !marketplace ? "listing-layout listing-layout--with-filters" : "listing-layout"}>
          {hasFilters && !marketplace && <ListingFilters key={filterKey} {...{ path, query, view }} />}
          <div className="listing-content">
            {marketplace && hasFilters ? <MarketplaceFilters key={filterKey} {...{ path, query, view }} currency={market.currency}/>
            : <div className="listing-toolbar">
              <div className="listing-results">
                <p>{view.cards.length} {view.cards.length === 1 ? "product" : "products"} <span>· {market.name}</span></p>
                {view.active && <Link href={resetHref}>Clear filters</Link>}
              </div>
              {hasFilters && <ListingSort key={`${path}:${query}:${view.sort}`} {...{ path, query, view }} />}
            </div>}
            {view.cards.length > 0 ? (
              <section aria-label="Products">
                <h2 className="sr-only">Products</h2>
                <ProductGrid cards={cards} market={market} activity={activity} placement={{ placement }} offset={offset} />
                {pageCount > 1 && <nav className="staff-filters" aria-label="Product pages">
                  {page > 1 && <Link href={pageHref(page - 1)}>Previous</Link>}
                  <span>Page {page} of {pageCount}</span>
                  {page < pageCount && <Link href={pageHref(page + 1)}>Next</Link>}
                </nav>}
              </section>
            ) : (
              <EmptyState
                title={view.active ? "No products match these filters" : "No products found"}
                description={view.active ? "Clear your filters or try a different combination." : query ? "Try a shorter search, another spelling, or browse all departments." : `There are no products in this selection for ${market.name}. Try another department or change your market.`}
              >
                <Link className="button button--primary" href={view.active ? resetHref : "/shop"}>{view.active ? "Clear filters" : "Shop all products"}</Link>
                {query && !view.active && <Link className="button button--outline" href="/search">Start a new search</Link>}
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
