"use client";

import Form from "next/form";
import Link from "next/link";
import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import type { BrowseFacetGroup } from "@/lib/catalog/category-browse-facets";
import { sortOptions } from "@/lib/catalog/listing";
import "./connected-browse-controls.css";

const filterFields = new Set(["brand", "model", "design", "color", "option", "attribute", "availability", "minMinor", "maxMinor", "sale", "priceCurrency"]);
const browseFields = [
  ...filterFields, "device", "offer", "min", "max", "minPrice", "maxPrice", "browseFrom", "page", "cursor",
  "sort", "q", "category", "department", "market", "lang", "country", "district", "method", "postalCode", "paymentMethod", "quantity",
];
type FilterProps = { path: string; query: string; facets: BrowseFacetGroup[]; market: Market };
type Price = { minMinor: number; maxMinor: number; currency: Market["currency"] } | null;

function browseHref(path: string, search: URLSearchParams) {
  return search.size ? `${path}?${search}` : path;
}

function clearHref(path: string, query: string) {
  const params = new URLSearchParams(query);
  for (const field of filterFields) params.delete(field);
  return browseHref(path, params);
}

function HiddenFields({ fields }: { fields: [string, string][] }) {
  return fields.map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" {...{ name, value }} />);
}

function FacetOptions({ group, selected }: { group: BrowseFacetGroup; selected: URLSearchParams }) {
  const description = useId();
  return <fieldset className="connected-facet">
    <legend>{group.label}</legend>
    <div className="connected-facet-values">
      {group.values.map(({ value, label, count }, index) => <label className="connected-facet-choice" key={value}>
        <input name={group.field} type="checkbox" value={value} defaultChecked={selected.getAll(group.field).includes(value)}
          aria-label={label} aria-describedby={`${description}-${index}`} />
        <span>{label}</span>
        <span aria-hidden="true" className="connected-facet-count">{count}</span>
        <span hidden id={`${description}-${index}`}>{count} {count === 1 ? "product" : "products"}</span>
      </label>)}
    </div>
  </fieldset>;
}

function FilterForm({ path, query, facets, price, market, onApply }: FilterProps & { price: Price; onApply?: () => void }) {
  const selected = new URLSearchParams(query);
  const visible = facets.filter(group => !group.secondary || group.values.some(value => selected.getAll(group.field).includes(value.value)));
  const handled = new Set(visible.flatMap(group => group.values.map(({ value }) => JSON.stringify([group.field, value]))));
  const passThrough = [...selected].filter(entry => !handled.has(JSON.stringify(entry)) &&
    !["minMinor", "maxMinor", "sale", "priceCurrency"].includes(entry[0]));
  const amount = (minor: string | null) => minor ? (Number(minor) / 10 ** market.minorDigits).toFixed(market.minorDigits) : "";
  const pricePresent = price || selected.has("minMinor") || selected.has("maxMinor");
  const active = [...selected.keys()].some(field => filterFields.has(field));
  return <Form action={path} prefetch={false} className="connected-filter-form" onSubmit={onApply}>
    <HiddenFields fields={passThrough} />
    {visible.length > 0 && visible.map(group => <FacetOptions group={group} key={group.id} selected={selected} />)}
    {pricePresent && <fieldset className="connected-facet connected-facet--price">
      <legend>Price ({market.currency})</legend>
      {price && <p className="connected-facet-range">{formatMoney(price.minMinor, market)} – {formatMoney(price.maxMinor, market)}</p>}
      <input type="hidden" name="priceCurrency" value={market.currency} />
      <div className="connected-facet-price">
        <label>Minimum<input inputMode="decimal" name="minPrice" defaultValue={amount(selected.get("minMinor"))}
          aria-label={`Minimum price in ${market.currency}`} maxLength={14} /></label>
        <label>Maximum<input inputMode="decimal" name="maxPrice" defaultValue={amount(selected.get("maxMinor"))}
          aria-label={`Maximum price in ${market.currency}`} maxLength={14} /></label>
      </div>
      {selected.get("sale") === "false" ? <input type="hidden" name="sale" value="false" /> : <label className="connected-facet-choice">
        <input type="checkbox" name="sale" value="true" defaultChecked={selected.get("sale") === "true"} />
        <span>On sale</span>
      </label>}
    </fieldset>}
    {!pricePresent && selected.has("sale") && <input type="hidden" name="sale" value={selected.get("sale")!} />}
    <div className="connected-filter-actions">
      <button className="button button--primary" type="submit">Apply filters</button>
      {active && onApply && <Link className="text-link" href={clearHref(path, query)} prefetch={false} onNavigate={onApply}>Reset filters</Link>}
    </div>
  </Form>;
}

export function ConnectedBrowseFilters({ price, normalizePage, ...props }: FilterProps & { price: Price; normalizePage?: number }) {
  const heading = useId();
  const drawerHeading = useId();
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { path, query } = props;
  useEffect(() => {
    if (normalizePage === undefined) return;
    const url = new URL(window.location.href);
    if (url.pathname !== storefrontPath(path)) return;
    for (const name of browseFields) url.searchParams.delete(name);
    for (const [name, value] of new URLSearchParams(query)) url.searchParams.append(name, value);
    if (normalizePage > 1) url.searchParams.set("page", String(normalizePage));
    if (url.href !== window.location.href) window.history.replaceState(null, "", url);
  }, [normalizePage, path, query]);
  function closeDrawer() { drawer.current?.close(); }
  return <div className="connected-filter-area">
    <aside className="connected-filter-sidebar" aria-labelledby={heading}>
      <h2 id={heading}>Filters</h2>
      <FilterForm {...props} key={props.query} price={price} />
    </aside>
    <div className="connected-filter-mobile">
      <button className="button button--outline" type="button" ref={trigger} aria-haspopup="dialog"
        onClick={() => drawer.current?.showModal()}><SlidersHorizontal aria-hidden="true" size={17} />Filters</button>
      <dialog ref={drawer} className="connected-filter-drawer" aria-labelledby={drawerHeading}
        onClose={() => trigger.current?.focus()}
        onClick={event => { if (event.target === event.currentTarget) closeDrawer(); }}>
        <div className="connected-filter-drawer-inner">
          <header className="connected-filter-drawer-heading">
            <h2 id={drawerHeading}>Filters</h2>
            <button className="button button--outline" type="button" onClick={closeDrawer} aria-label="Close filters">
              <X size={19} aria-hidden="true" />
            </button>
          </header>
          <FilterForm {...props} key={props.query} price={price} onApply={closeDrawer} />
        </div>
      </dialog>
    </div>
  </div>;
}

export function ConnectedBrowseSort({ path, query }: { path: string; query: string }) {
  const params = new URLSearchParams(query);
  return <Form action={path} aria-label="Sort products" className="listing-sort connected-browse-sort" prefetch={false} key={query}>
    <HiddenFields fields={[...params].filter(([name]) => name !== "sort")} />
    <label><span>Sort by</span><select name="sort" defaultValue={params.get("sort") ?? "recommended"}>
      {sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <button type="submit" className="button button--outline">Apply sort</button>
  </Form>;
}

const fallbackLabel = { brand: "Brand", model: "Device or model", design: "Design", color: "Colour",
  option: "Option", attribute: "Specification", availability: "Availability" } as const;

export function ConnectedBrowseChips({ path, query, facets, market, clearLabel = "Clear all" }: FilterProps & { clearLabel?: string }) {
  const params = new URLSearchParams(query);
  const chips = [...params].flatMap(([field, value]) => {
    if (field === "sale") return [{ field, value, label: value === "true" ? "On sale" : "Regular price" }];
    if (field === "minMinor" || field === "maxMinor") return [{ field, value,
      label: `${field === "minMinor" ? "Minimum" : "Maximum"}: ${formatMoney(Number(value), market)}` }];
    if (!Object.hasOwn(fallbackLabel, field)) return [];
    const group = facets.find(group => group.field === field && group.values.some(choice => choice.value === value));
    const option = group?.values.find(choice => choice.value === value);
    const name = group?.label ?? fallbackLabel[field as keyof typeof fallbackLabel];
    const label = `${name}: ${option?.label ?? value}`;
    return [{ field, value, label }];
  });
  if (!chips.length) return null;
  return <div className="connected-filter-chips" aria-label="Applied filters" role="group">
    {chips.map(({ field, value, label }) => {
      const next = new URLSearchParams(params);
      next.delete(field, value);
      if (!next.has("minMinor") && !next.has("maxMinor")) next.delete("priceCurrency");
      return <Link key={`${field}:${value}`} href={browseHref(path, next)} prefetch={false}
        className="connected-filter-chip" aria-label={`Remove ${label}`}>{label}<X aria-hidden="true" size={14}/></Link>;
    })}
    <Link href={clearHref(path, query)} prefetch={false} className="text-link">{clearLabel}</Link>
  </div>;
}

export function ConnectedBrowsePagination({ path, query, page, pageCount, label = "Category result pages" }:
  { path: string; query: string; page: number; pageCount: number; label?: string }) {
  if (pageCount < 2) return null;
  const href = (requested: number) => {
    const params = new URLSearchParams(query);
    if (requested > 1) params.set("page", String(requested));
    return browseHref(path, params);
  };
  return <nav className="connected-browse-pagination" aria-label={label}>
    {page > 1 && <Link className="button button--outline" href={href(page - 1)} prefetch={false} rel="prev">Previous page</Link>}
    <p aria-current="page">Page {page} of {pageCount}</p>
    {page < pageCount && <Link className="button button--outline" href={href(page + 1)} prefetch={false} rel="next">Next page</Link>}
  </nav>;
}
