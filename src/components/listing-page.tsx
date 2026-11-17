import Form from "next/form";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Market } from "@/config/markets";
import { localizedStoreHref, marketStoreHref } from "@/config/regional-path";
import { listingView, sortOptions, type SearchParams } from "@/lib/catalog/listing";
import { searchDevice } from "@/lib/catalog/search";
import { cardActivity } from "@/lib/catalog/card-activity";
import { activeOffer, readAdminContent } from "@/lib/marketplace/admin-content";
import type { CatalogProduct, Department } from "@/lib/catalog/types";
import { ListingPagination } from "./listing-pagination";
import { ProductGrid } from "./product-grid";
import { Breadcrumbs, EmptyState } from "./store-ui";
import { MarketplaceFilters } from "./marketplace/filters";
import { SaleOfferCountdown } from "./marketplace/sale-offer-countdown";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

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
  path: barePath, title, description, market, departments, products, params, departmentPage, childDepartments, parentDepartment, query, newest = false,
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
  const regional = hybridDemoMode();
  const region = regional ? market.id : undefined;
  const href = (path: string) => marketStoreHref(path, region);
  const path = localizedStoreHref(barePath, region);
  const view = listingView(products, departments, params, departmentPage, newest ? "newest" : "recommended",
    marketplace ? market.minorDigits : undefined, marketplace, query ? searchDevice(query)?.id : undefined);
  const resetHref = href(query ? `${path}?q=${encodeURIComponent(query)}` : path);
  const hasFilters = products.length > 0;
  const filterKey = [path, query, view.department, view.color, view.device, view.inStock, view.min, view.max, view.sale, view.shop].join(":");
  const { cards: allCards, active, departmentChoices, devices, ...filterValues } = view;
  const resultCount = allCards.length;
  const filterView = {
    ...filterValues,
    resultCount,
    departmentChoices: departmentChoices.map(({ id, slug, shortName }) => ({ id, slug, shortName })),
    devices: devices.map(({ id, name }) => ({ id, name })),
  };
  const pageSize = 24;
  const pageCount = Math.max(1, Math.ceil(resultCount / pageSize));
  const requestedPage = typeof params.page === "string" && /^\d{1,5}$/.test(params.page) ? Number(params.page) : 1;
  const page = Math.min(pageCount, Math.max(1, requestedPage));
  const cards = allCards.slice((page - 1) * pageSize, page * pageSize);
  const [activity, adminContent] = await Promise.all([
    marketplace ? cardActivity(market.id, cards.map(card => card.id)) : undefined,
    regional && market.id === "bd" && view.sale ? readAdminContent() : null,
  ]);
  const campaign = activeOffer(adminContent?.offer);

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
    return href(suffix ? `${path}?${suffix}` : path);
  }

  return (
    <div className="shell inner-page listing-page">
      <Breadcrumbs items={[
        ...(parentDepartment ? [{ label: parentDepartment.shortName, href: href(`/departments/${parentDepartment.slug}`) }] : []),
        { label: query === undefined ? title : "Search" },
      ]} />
      <div className="listing-intro">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {campaign && <SaleOfferCountdown campaign={campaign} market={market} className="mp-listing-sale-countdown" />}
      {childDepartments && childDepartments.length > 0 &&
        <nav className="mp-subcategory-links" aria-label="Subcategories">
          {childDepartments.map(({ id, shortName, slug }) => <Link key={id} href={href(`/departments/${slug}`)}>{shortName}</Link>)}
        </nav>}
      {query === "" ? (
        <EmptyState title="What are you looking for?" description="Search by product, department, or a detail like “cotton” or “USB-C” using the search bar.">
          <Link className="button button--primary" href={href("/shop")}>Browse all products <ArrowRight aria-hidden="true" size={17} /></Link>
        </EmptyState>
      ) : (
        <div className={hasFilters && !marketplace ? "listing-layout listing-layout--with-filters" : "listing-layout"}>
          {hasFilters && !marketplace && <ListingFilters key={filterKey} {...{ path, query, view }} />}
          <div className="listing-content">
            {marketplace && hasFilters ? <MarketplaceFilters key={filterKey} path={path} query={query} view={filterView} currency={market.currency} region={region}/>
            : <div className="listing-toolbar">
              <div className="listing-results">
                <p>{resultCount} {resultCount === 1 ? "product" : "products"} <span>· {market.name}</span></p>
                {active && <Link href={resetHref}>Clear filters</Link>}
              </div>
              {hasFilters && <ListingSort key={`${path}:${query}:${view.sort}`} {...{ path, query, view }} />}
            </div>}
            {cards.length > 0 ? (
              <section aria-label="Products">
                <h2 className="sr-only">Products</h2>
                <ProductGrid cards={cards} market={market} regional={regional} activity={activity} />
                <ListingPagination {...{ page, pageCount, pageHref }} />
              </section>
            ) : (
              <EmptyState
                title={active ? "No products match these filters" : "No products found"}
                description={active ? "Clear your filters or try a different combination." : query ? "Try a shorter search, another spelling, or browse all departments." : `There are no products in this selection for ${market.name}. Try another department or change your market.`}
              >
                <Link className="button button--primary" href={active ? resetHref : href("/shop")}>{active ? "Clear filters" : "Shop all products"}</Link>
                {query && !active && <Link className="button button--outline" href={href("/search")}>Start a new search</Link>}
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
