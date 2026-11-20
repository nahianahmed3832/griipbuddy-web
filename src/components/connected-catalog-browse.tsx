import { ChevronRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney, type Market } from "@/config/markets";
import { localizedStorePath } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { browseRequestState, clearBrowseFilters, needsBrowseUrlNormalization } from "@/lib/catalog/browse-url-state";
import { catalogBrowseHref, catalogProductHref } from "@/lib/catalog/category-browse-links";
import { categoryBrowseControls, prepareCategoryBrowseQuery } from "@/lib/catalog/category-browse-query";
import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { connectedCategoryTree, type connectedCategoryCollections, type connectedCategoryDetail, type connectedCollectionDetail } from "@/lib/catalog/connected-navigation";
import { CatalogApiError } from "@/lib/catalog/connected-public";
import { heroPhoto } from "@/lib/catalog/imagery";
import type { SearchParams } from "@/lib/catalog/listing";
import { hybridDemoMode } from "@/lib/release-config";
import { BrowseUrlNormalization } from "./browse-url-normalization";
import { ConnectedBrowseChips, ConnectedBrowseFilters, ConnectedBrowsePagination, ConnectedBrowseSort } from "./connected-browse-controls";
import { CategoryListingMeasurement, ListingMeasurement, MeasuredCategoryLink, MeasuredProductLink } from "./measurement-observers";
import { Breadcrumbs, EmptyState, SectionHeading } from "./store-ui";
import "./connected-catalog-browse.css";

type Category = NonNullable<Awaited<ReturnType<typeof connectedCategoryDetail>>>;
type Collection = NonNullable<Awaited<ReturnType<typeof connectedCollectionDetail>>>["collection"];
type Card = Awaited<ReturnType<typeof listConnectedCatalog>>["items"][number];
type RelatedCollections = Awaited<ReturnType<typeof connectedCategoryCollections>>;
type Destination = { type: "category"; data: Category; collections: RelatedCollections } |
  { type: "collection"; data: Collection } | { type: "shop"; categories: Category["children"] };

export function ConnectedCatalogCards({ products, market, categoryId, offset, placement, linkToRepresentative = false }: {
  products: Card[]; market: Market; categoryId?: string; offset: number; linkToRepresentative?: boolean;
  placement: "category-grid" | "collection" | "search-results" | "shop";
}) {
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const search = placement === "search-results";
  return <ul className="product-grid connected-catalog-grid">
    {products.map((product, index) => {
      const { representative, fromPrice } = product;
      const { image, offer, availability } = representative;
      const localOffer = offer.marketId === market.id && offer.currency === market.currency;
      const representativeLink = linkToRepresentative && localOffer && offer.eligible;
      const selection = representativeLink ? { ...product, matchedVariantId: representative.variantId } : product;
      const known = representativeLink ? [] : product.knownOptions;
      const labels = [...new Set((known.length ? known : representative.options).map(option => option.valueLabel).filter(Boolean))].slice(0, 3);
      const exact = selection.matchedVariantId === representative.variantId;
      const price = localOffer && offer.eligible ? offer.amountMinor : undefined;
      const range = !selection.matchedVariantId && fromPrice?.currency === market.currency &&
        fromPrice.maxAmountMinor > fromPrice.amountMinor;
      const comparison = exact && price !== undefined && offer.regularMinor > price ? offer.regularMinor : undefined;
      const unavailable = availability === "out_of_stock" ? "Out of stock"
        : availability === "delivery_unavailable" ? "Unavailable for this delivery" : null;
      const shownOption = !exact;
      return <li key={product.id}>
        <MeasuredProductLink className="product-card" href={catalogProductHref(selection, context, categoryId)} prefetch={false}
          card={{ id: product.id, variantId: selection.matchedVariantId ?? undefined, priceMinor: price,
            offerId: search && product.matchedVariantId ? offer.id ?? undefined : undefined }}
          market={market} context={{ categoryId, placement, position: offset + index + 1 }}>
          <div className="product-card__image">
            {image ? <Image src={storefrontPath(image.src)} alt={image.alt} fill unoptimized={search}
              sizes="(max-width: 759px) 47vw, (max-width: 1050px) 27vw, 280px" />
              : <span className="connected-card-image-placeholder">Image unavailable</span>}
            {unavailable && <span className="product-card__badge">{shownOption
              ? `Shown option ${unavailable.toLowerCase()}` : unavailable}</span>}
          </div>
          <h3>{product.name}</h3>
          {!!labels.length && <p className="connected-card-options">
            {!known.length && (shownOption || search) && "Shown in "}{labels.join(" · ")}
          </p>}
          {search && product.searchMatch && product.searchMatch.kind !== "text" && !labels.includes(product.searchMatch.label) &&
            <p className="connected-card-options">{product.searchMatch.label}</p>}
          {price === undefined ? <p className="connected-card-unavailable">Unavailable in this market</p>
            : <p className="product-card__price">
              {range && <span>{price === fromPrice.amountMinor ? "From " : "Shown option "}</span>}
              <data value={price}>{formatMoney(price, market)}</data>
              {comparison !== undefined && <> <span className="sr-only">Regular price </span>
                <del className="connected-card-comparison">{formatMoney(comparison, market)}</del></>}
            </p>}
        </MeasuredProductLink>
      </li>;
    })}
  </ul>;
}

function CategoryShortcuts({ categories, market, compact = false }: { categories: Category["children"]; market: Market; compact?: boolean }) {
  const children = categories.filter(child => child.visibleInNavigation);
  if (!children.length) return null;
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  return <section className="connected-catalog-section" aria-labelledby="catalog-category-children">
    <SectionHeading id="catalog-category-children" title={compact ? "Subcategories" : "Shop by category"} />
    <ul className={compact ? "connected-category-shortcuts connected-category-shortcuts--compact" : "connected-category-shortcuts"}>
      {children.map((child, index) => <li key={child.id}>
        <MeasuredCategoryLink categoryId={child.id} marketId={market.id} context={{ placement: "category-children", position: index + 1 }}
          className="collection-card" href={catalogBrowseHref(`/departments/${encodeURIComponent(child.localizedSlug)}`, context)} prefetch={false}>
          <span className="collection-card__visual">
            <Image src={storefrontPath(child.image.src)} alt="" fill sizes={compact ? "44px" : "(max-width: 759px) 46vw, 240px"} />
          </span>
          <span className="collection-card__name">{child.shortName}</span>
          {compact && <ChevronRight aria-hidden="true" size={16} />}
        </MeasuredCategoryLink>
      </li>)}
    </ul>
  </section>;
}

function CategoryCollections({ collections, market }: { collections: RelatedCollections; market: Market }) {
  if (!collections.length) return null;
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  return <section className="connected-catalog-section" aria-labelledby="catalog-related-collections">
    <SectionHeading id="catalog-related-collections" title="Collections to explore" />
    <ul className="connected-category-shortcuts">
      {collections.map(collection => <li key={collection.id}>
        <Link className="collection-card" href={catalogBrowseHref(`/collections/${encodeURIComponent(collection.slug)}`, context)} prefetch={false}>
          {collection.image && <span className="collection-card__visual">
            <Image src={storefrontPath(collection.image.src)} alt="" fill sizes="(max-width: 759px) 46vw, 240px" />
          </span>}
          <span className="collection-card__name">{collection.name}</span>
        </Link>
      </li>)}
    </ul>
  </section>;
}

export async function ConnectedCatalogBrowse({ destination, market, raw }: { destination: Destination; market: Market; raw: SearchParams }) {
  const category = destination.type === "category" ? destination.data.category : null;
  const collection = destination.type === "collection" ? destination.data : null;
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const name = category?.name ?? collection?.name ?? "Shop all";
  const description = category?.description ?? collection?.description;
  const banner = category?.banner ?? collection?.image;
  const categoryImage = category && category.image.src !== heroPhoto.src ? category.image : null;
  const image = banner ?? categoryImage;
  const headingClass = banner ? "connected-catalog-heading with-banner"
    : image ? "connected-catalog-heading with-banner with-category-image" : "connected-catalog-heading";
  const isDepartment = category?.kind === "DEPARTMENT" || category?.kind === null && category.parentId === null;
  const absolutePath = category ? `/departments/${encodeURIComponent(category.localizedSlug)}`
    : collection ? `/collections/${encodeURIComponent(collection.slug)}` : "/shop";
  const shopHref = catalogBrowseHref("/shop", context);
  const path = context.regional ? localizedStorePath(absolutePath, market.id) : absolutePath;
  const defaultSort = collection?.selection === "NEW" ? "newest" : "recommended";
  const defaults = defaultSort === "newest" && raw.sort === undefined ? { ...raw, sort: defaultSort } : raw;
  const prepared = prepareCategoryBrowseQuery(defaults, market, { category: category?.id, collection: collection?.id });
  let listing;
  try {
    listing = await listConnectedCatalog(prepared.params, { marketId: market.id, locale: market.locale, delivery: prepared.delivery }, undefined, undefined,
      { browsePage: prepared.page, keepUnmatchedFacets: destination.type === "shop" && !prepared.changedMarket });
  } catch (error) {
    if (!(error instanceof CatalogApiError)) throw error;
    if (category && error.code === "category_not_found" || collection && error.code === "collection_not_found") notFound();
    if (error.code !== "catalog_scope_too_broad") throw error;
  }
  const browse = listing?.browse;
  const controls = categoryBrowseControls(prepared, browse);
  const query = new URLSearchParams(controls.query);
  const source = browseRequestState(raw);
  const page = browse?.page ?? prepared.page;
  const emptyTitle = controls.hasFilters ? "No products match these filters" : query.has("q") ? "No products found"
    : collection ? "This collection is empty"
    : category ? "No products in this category yet" : "No products here yet";
  const pageLabel = category ? "Category result pages" : collection ? "Collection result pages" : "Shop result pages";

  return <div className="shell inner-page listing-page connected-catalog">
    {needsBrowseUrlNormalization(source, page, Boolean(controls.notice)) &&
      <BrowseUrlNormalization path={path} source={source} query={controls.query} page={page} />}
    {category && listing && <CategoryListingMeasurement categoryId={category.id} marketId={market.id}
      resultCount={listing.total} filterKey={controls.filterKey} filterFields={controls.filterFields}
      sort={prepared.sort} />}
    {destination.type !== "category" && listing && <ListingMeasurement marketId={market.id} placement={destination.type}
      listingId={collection?.id} filterKey={controls.filterKey}
      query={query.get("q") ?? undefined} active={controls.active || Boolean(prepared.sort && prepared.sort !== defaultSort)}
      resultCount={listing.total} filters={{
        sort: prepared.sort,
        availability: query.getAll("availability").includes("available") ? "in-stock" : undefined,
        offer: query.get("sale") === "true" ? "sale" : undefined,
        min: query.has("minMinor") ? Number(query.get("minMinor")) : undefined,
        max: query.has("maxMinor") ? Number(query.get("maxMinor")) : undefined,
      }} />}
    <Breadcrumbs homeHref={catalogBrowseHref("/", context)} items={[
      ...(destination.type !== "shop" ? [{ label: "Shop all", href: shopHref }] : []),
      ...(destination.type === "category" ? destination.data.ancestors.map(row => ({
        label: row.shortName, href: catalogBrowseHref(`/departments/${encodeURIComponent(row.localizedSlug)}`, context),
      })) : []), { label: name },
    ]} />
    <header className={headingClass}>
      <div><h1 className="display-type">{name}</h1>{description && <p>{description}</p>}</div>
      {image && <div className="connected-catalog-banner">
        <Image src={storefrontPath(image.src)} alt={image.alt} fill
          sizes={banner ? "(max-width: 759px) 94vw, 55vw" : "(max-width: 759px) 94vw, 320px"} preload />
      </div>}
    </header>
    {destination.type === "category" && <>
      <CategoryShortcuts categories={destination.data.children} market={market} compact={!isDepartment} />
      <CategoryCollections collections={destination.collections} market={market} />
    </>}
    {destination.type === "shop" && <CategoryShortcuts categories={destination.categories} market={market} />}
    {listing && browse ? (
      <div className="connected-browse-results">
        <ConnectedBrowseFilters path={path} query={controls.query} facets={browse.facets} price={browse.price} market={market} />
        <section className="connected-catalog-results" aria-labelledby="catalog-results-heading">
          <h2 id="catalog-results-heading" className="connected-results-title">Products</h2>
          {controls.notice && <p className="connected-browse-notice" role="status">{controls.notice}</p>}
          <div className="listing-toolbar">
            <p className="listing-results" aria-live="polite">{listing.total.toLocaleString(market.locale)} {listing.total === 1 ? "product" : "products"}</p>
            <ConnectedBrowseSort path={path} query={controls.query} />
          </div>
          <ConnectedBrowseChips path={path} query={controls.query} facets={browse.facets} market={market} />
          {listing.items.length ? <ConnectedCatalogCards products={listing.items} market={market} categoryId={category?.id}
            placement={category ? "category-grid" : destination.type === "collection" ? "collection" : "shop"}
            linkToRepresentative={destination.type === "shop" && !controls.active}
            offset={(browse.page - 1) * prepared.pageSize} /> : <EmptyState title={emptyTitle}
            description={controls.hasFilters ? "Remove a filter or try another combination."
              : `Explore other categories available in ${market.name}.`}>
            {(controls.active || destination.type !== "shop") && <Link className="button button--outline"
              href={controls.hasFilters ? clearBrowseFilters(path, controls.query) : shopHref} prefetch={false}>
              {controls.hasFilters ? "Clear filters" : "Browse all products"}
            </Link>}
          </EmptyState>}
          <ConnectedBrowsePagination path={path} query={controls.query} page={browse.page} pageCount={browse.pageCount}
            label={pageLabel} />
        </section>
      </div>
    ) : <section aria-labelledby="catalog-results-heading">
      <h2 id="catalog-results-heading" className="connected-results-title">Products</h2>
      {controls.notice && <p className="connected-browse-notice" role="status">{controls.notice}</p>}
      <EmptyState title="Explore a smaller range" description="Choose a smaller category to see its products and filters.">
        {destination.type !== "shop" && <Link className="button button--outline" href={shopHref} prefetch={false}>Browse all categories</Link>}
      </EmptyState>
    </section>}
  </div>;
}

export async function CatalogMarketFallback({ market, missing }: { market: Market; missing: "category" | "collection" | "shop" }) {
  const { categories } = await connectedCategoryTree({ marketId: market.id, locale: market.locale });
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  return <div className="shell inner-page connected-catalog">
    <Breadcrumbs homeHref={catalogBrowseHref("/", context)} items={[{ label: "Shop all" }]} />
    <header className="connected-catalog-heading">
      <h1 className="display-type">Shop all</h1>
      <p role="status">That {missing} is unavailable in {market.name}. Browse this market’s catalog below.</p>
    </header>
    <CategoryShortcuts categories={categories} market={market} />
    <Link href={catalogBrowseHref("/shop", context)} className="text-link" prefetch={false}>Browse all products</Link>
  </div>;
}

