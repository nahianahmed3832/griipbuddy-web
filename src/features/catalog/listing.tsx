import Link from 'next/link';
import { ChevronRight, Search } from 'lucide-react';
import { attribute, categoryAt, categoryHref, marketHref, type CatalogProduct, type Category, type CollectionId, type Market } from './catalog';
import { compareProducts, inCategory, inCollection, matchingVariants, parseFilters, relevance, sortLabels, type CatalogParams, type Filters } from './browse';
import { catalogProducts, mapLimited, variantStock, withAvailability } from './data';
import { ProductCard } from './product-card';
import { SearchBox } from './search-box';
import { FilterDisclosure } from './filter-disclosure';

const perPage = 20;
const stockBudget = 240;

export function Breadcrumbs({ market, categories, path, current }: {
  market: Market; categories: Category[]; path: string[]; current: string;
}) {
  return (
    <nav className="catalog-breadcrumbs" aria-label="Breadcrumb">
      <Link href={marketHref(market)}>Home</Link>
      <ChevronRight size={13} aria-hidden />
      <Link href={marketHref(market, '/products')}>Shop</Link>
      {path.map((_, index) => {
        const category = categoryAt(categories, path.slice(0, index + 1));
        return category ? <span className="breadcrumb-step" key={category.id}>
          <ChevronRight size={13} aria-hidden /><Link href={categoryHref(market, category.path)}>{category.label}</Link>
        </span> : null;
      })}
      <ChevronRight size={13} aria-hidden /><span aria-current="page">{current}</span>
    </nav>
  );
}

export function CatalogGrid({ products, market, linkVariant = false }: {
  products: CatalogProduct[]; market: Market; linkVariant?: boolean;
}) {
  return <div className="product-grid">{products.map((product) => (
    <ProductCard key={product.id} product={product} market={market} linkVariant={linkVariant} />
  ))}</div>;
}

function choices(values: string[], current = '') {
  return [...new Set([...values, current].filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function SelectFilter({ label, name, selected, options }: {
  label: string; name: string; selected: string; options: { value: string; label: string }[];
}) {
  if (!options.length && !selected) return null;
  return <label className="filter-field">
    <span>{label}</span>
    <select name={name} defaultValue={selected}>
      <option value="">Any</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function FilterPanel({ market, filters, products, categories, action, scoped }: {
  market: Market; filters: Filters; products: CatalogProduct[]; categories: Category[]; action: string; scoped: boolean;
}) {
  const brands = [...new Map(products.flatMap((product) => product.brand ? [[product.brand.id, product.brand.name] as const] : [])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (filters.brand && !brands.some(([id]) => id === filters.brand)) brands.push([filters.brand, 'Selected brand']);
  const variants = products.flatMap((product) => product.variants.filter((variant) => variant.price));
  const sizes = choices(variants.flatMap((variant) => attribute(variant, 'size') ?? []), filters.size);
  const colors = choices(variants.flatMap((variant) => attribute(variant, 'color') ?? attribute(variant, 'colour') ?? []), filters.color);
  const asOptions = (values: string[]) => values.map((value) => ({ value, label: value }));
  const applied = [filters.category, filters.brand, filters.size, filters.color, filters.availability,
    filters.min !== undefined, filters.max !== undefined].filter(Boolean).length;

  return (
    <FilterDisclosure applied={applied}>
      <form className="catalog-filters" action={action} method="get">
        {filters.query && <input type="hidden" name="q" value={filters.query} />}
        {filters.sort && <input type="hidden" name="sort" value={filters.sort} />}
        {!scoped && <SelectFilter label="Category" name="category" selected={filters.category}
          options={categories.map((category) => ({ value: category.slug, label: category.label }))} />}
        <SelectFilter label="Brand" name="brand" selected={filters.brand} options={brands.map(([value, label]) => ({ value, label }))} />
        <SelectFilter label="Size" name="size" selected={filters.size} options={asOptions(sizes)} />
        <SelectFilter label="Color" name="color" selected={filters.color} options={asOptions(colors)} />
        <fieldset className="price-filters">
          <legend>Price ({market.currency})</legend>
          <label className="filter-field">Min<input name="min" type="number" min="0" step="0.01" defaultValue={filters.min} /></label>
          <label className="filter-field">Max<input name="max" type="number" min="0" step="0.01" defaultValue={filters.max} /></label>
        </fieldset>
        <SelectFilter label="Availability" name="availability" selected={filters.availability ?? ''}
          options={[{ value: 'in', label: 'In stock' }, { value: 'out', label: 'Out of stock' }]} />
        <div className="filter-actions">
          <button type="submit" className="button button-primary">Apply filters</button>
          <Link className="text-link" href={action + (filters.query ? '?q=' + encodeURIComponent(filters.query) : '')}>Clear filters</Link>
        </div>
      </form>
    </FilterDisclosure>
  );
}

function queryFor(filters: Filters) {
  const query = new URLSearchParams();
  const entries = {
    q: filters.query, category: filters.category, brand: filters.brand, size: filters.size, color: filters.color,
    min: filters.min, max: filters.max, availability: filters.availability, sort: filters.sort,
  };
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return query;
}

async function filterStock(products: CatalogProduct[], availability: NonNullable<Filters['availability']>) {
  return (await mapLimited(products, 8, async (product) => {
    const available = [];
    let allOut = true;
    for (const variant of product.variants) {
      const stock = await variantStock(product, variant);
      if (stock !== 0) allOut = false;
      if (stock !== null && stock > 0) available.push(variant);
    }
    if (availability === 'in' && available.length) return { ...product, variants: available, availability: 'in' as const };
    if (availability === 'out' && allOut) return { ...product, availability: 'out' as const };
    return undefined;
  })).flatMap((product) => product ?? []);
}

export async function CatalogListing({ market, categories, category, collection, params, title, description, path, search = false }: {
  market: Market;
  categories: Category[];
  category?: Category;
  collection?: CollectionId;
  params: CatalogParams;
  title: string;
  description?: string;
  path: string;
  search?: boolean;
}) {
  const filters = parseFilters(params, search ? 'relevance' : collection === 'best-sellers' ? 'popular' : 'newest');
  const action = marketHref(market, path);
  const scope = category ?? categories.find((entry) => entry.slug === filters.category);
  const products = await catalogProducts(market, filters.sort === 'popular' || collection === 'best-sellers', scope?.path[0]);
  const scores = new Map<string, number>();
  const scopeProducts = products.filter((product) => {
    if (!inCollection(product, collection) || (scope && !inCategory(product, scope.path))) return false;
    const score = relevance(product, filters.query, categoryAt(categories, product.category)?.label);
    scores.set(product.id, score);
    return score >= 0;
  });

  let matching = scopeProducts.flatMap((product) => {
    const variants = matchingVariants(product, filters);
    return variants.length && (!filters.brand || product.brand?.id === filters.brand) ? [{ ...product, variants }] : [];
  });
  let notice = '';
  if (filters.min !== undefined && filters.max !== undefined && filters.min > filters.max) notice = 'Minimum price must be less than or equal to maximum price.';
  if (filters.availability && !notice) {
    const variantCount = matching.reduce((sum, product) => sum + product.variants.length, 0);
    if (variantCount > stockBudget) notice = 'Narrow the catalog with another filter before checking availability.';
    else matching = await filterStock(matching, filters.availability);
  }

  matching.sort((a, b) => (filters.sort === 'relevance' ? (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) : 0)
    || compareProducts(a, b, filters.sort));
  const total = matching.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(filters.page, pages);
  const window = matching.slice((page - 1) * perPage, page * perPage);
  const visible = notice ? [] : filters.availability ? window : await withAvailability(window);
  const query = queryFor(filters);
  const pageHref = (index: number) => action + '?' + new URLSearchParams([...query, ['page', String(index)]]);
  const ancestors = category?.path.slice(0, -1) ?? [];

  return (
    <div className="container catalog-page">
      <Breadcrumbs market={market} categories={categories} path={ancestors} current={title} />
      <div className="catalog-heading">
        <p className="eyebrow">{search ? 'DISCOVER' : collection ? 'COLLECTION' : 'THE CATALOG'}</p>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {search && <SearchBox key={filters.query + filters.category} market={market} style="page" initialQuery={filters.query} initialCategory={filters.category} />}
        {category?.children.length ? <nav className="category-chips" aria-label="Subcategories">
          {category.children.map((child) => <Link key={child.id} href={categoryHref(market, child.path)}>{child.label}<ChevronRight size={14} aria-hidden /></Link>)}
        </nav> : null}
      </div>
      <div className="catalog-layout">
        <aside aria-label="Catalog filters">
          <FilterPanel market={market} filters={filters} products={scopeProducts} categories={categories} action={action} scoped={Boolean(category)} />
        </aside>
        <section aria-label="Catalog results" className="catalog-results">
          <div className="results-toolbar">
            <p>{notice ? 'Update filters' : total + (total === 1 ? ' product' : ' products')}{filters.query && ' for “' + filters.query + '”'}</p>
            <form className="sort-form" action={action} method="get">
              {[...query].filter(([name]) => name !== 'sort').map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
              <label>Sort by <select name="sort" defaultValue={filters.sort} aria-label="Sort by">
                {Object.entries(sortLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></label>
              <button className="button button-outline" type="submit">Sort</button>
            </form>
          </div>
          {notice ? <p className="catalog-notice" role="status">{notice}</p>
            : visible.length ? <CatalogGrid products={visible} market={market} linkVariant={Boolean(filters.size || filters.color || filters.min !== undefined || filters.max !== undefined || filters.availability)} />
              : <div className="empty-state"><Search aria-hidden /><h2>No products found</h2><p>Try another search or clear your filters.</p></div>}
          {!notice && pages > 1 && <nav className="catalog-pagination" aria-label="Product pages">
            {page > 1 && <Link className="button button-outline" href={pageHref(page - 1)}>Previous</Link>}
            <span>Page {page} of {pages}</span>
            {page < pages && <Link className="button button-outline" href={pageHref(page + 1)}>Next</Link>}
          </nav>}
        </section>
      </div>
    </div>
  );
}
