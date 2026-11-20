"use client";

import Form from "next/form";
import Link from "next/link";
import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { priceInMinor } from "@/lib/catalog/browse-price-input";
import { browseFilterFields, browseParamsWithoutFilters, clearBrowseFilters } from "@/lib/catalog/browse-url-state";
import type { BrowseFacetGroup } from "@/lib/catalog/category-browse-facets";
import { sortOptions } from "@/lib/catalog/listing";
import { catalogSearchKey } from "@/lib/catalog/search-match";
import { optionColorSwatch } from "./option-color-swatch";
import "./connected-browse-controls.css";

const filterFields = new Set<string>(browseFilterFields);
const priceFields = new Set(["minMinor", "maxMinor", "sale", "priceCurrency"]);
type FilterProps = { path: string; query: string; facets: BrowseFacetGroup[]; market: Market };
type Price = { minMinor: number; maxMinor: number; currency: Market["currency"] } | null;
type PriceSide = "minimum" | "maximum";
type PriceError = { side: PriceSide; message: string };

function browseHref(path: string, search: URLSearchParams) {
  return search.size ? `${path}?${search}` : path;
}

function firstPageParams(query: string) {
  const params = new URLSearchParams(query);
  params.delete("page");
  params.delete("cursor");
  return params;
}

function HiddenFields({ fields }: { fields: [string, string][] }) {
  return fields.map(([name, value], index) => <input key={`${name}-${index}`} type="hidden" {...{ name, value }} />);
}

function FacetOptions({ group, selected, locale, onChoice }: {
  group: BrowseFacetGroup;
  selected: URLSearchParams;
  locale: string;
  onChoice: (field: string, value: string, checked: boolean) => void;
}) {
  const description = useId();
  const [search, setSearch] = useState("");
  const needle = catalogSearchKey(search);
  const matching = needle ? group.values.filter(({ label, value }) =>
    catalogSearchKey(label).includes(needle) || catalogSearchKey(value).includes(needle)) : group.values;
  const chosen = new Set(selected.getAll(group.field));
  const shown = new Set(matching.map(({ value }) => value));
  const hiddenChoices = group.values.flatMap(({ value }): [string, string][] =>
    chosen.has(value) && !shown.has(value) ? [[group.field, value]] : []);
  const searchLabel = `Search ${group.label.toLocaleLowerCase(locale)}`;
  return <fieldset className="connected-facet">
    <legend>{group.label}</legend>
    {group.values.length >= 8 && <input className="connected-facet-search" type="search" aria-label={searchLabel}
      placeholder={searchLabel} value={search} onChange={event => setSearch(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
      }} />}
    <HiddenFields fields={hiddenChoices} />
    <div className="connected-facet-values">
      {matching.map(({ value, label, count }, index) => {
        const swatch = group.field === "color" ? optionColorSwatch(value) ?? optionColorSwatch(label) : undefined;
        const countLabel = count.toLocaleString(locale);
        return <label className="connected-facet-choice" key={value}>
          <input name={group.field} type="checkbox" value={value} checked={chosen.has(value)}
            aria-label={label} aria-describedby={`${description}-${index}`}
            onChange={event => onChoice(group.field, value, event.target.checked)} />
          <span className="connected-facet-label">
            {swatch && <span className="connected-facet-swatch" style={{ backgroundColor: swatch }} aria-hidden="true" />}
            <span>{label}</span>
          </span>
          <span aria-hidden="true" className="connected-facet-count">{countLabel}</span>
          <span hidden id={`${description}-${index}`}>{countLabel} {count === 1 ? "product" : "products"}</span>
        </label>;
      })}
      {!matching.length && <p className="connected-facet-no-matches" role="status">No values match your search.</p>}
    </div>
  </fieldset>;
}

function FilterForm({ path, query, facets, price, market, onApply }: FilterProps & { price: Price; onApply?: () => void }) {
  const applied = firstPageParams(query);
  const [selected, setSelected] = useState(() => firstPageParams(query));
  const amount = (minor: string | null) => minor ? (Number(minor) / 10 ** market.minorDigits).toFixed(market.minorDigits) : "";
  const [minimum, setMinimum] = useState(() => amount(applied.get("minMinor")));
  const [maximum, setMaximum] = useState(() => amount(applied.get("maxMinor")));
  const [priceError, setPriceError] = useState<PriceError>();
  const errorId = useId();
  const minimumInput = useRef<HTMLInputElement>(null);
  const maximumInput = useRef<HTMLInputElement>(null);
  const visible = facets.filter(group => !group.secondary || group.values.some(value => applied.getAll(group.field).includes(value.value)));
  const handled = new Set(visible.flatMap(group => group.values.map(({ value }) => JSON.stringify([group.field, value]))));
  const passThrough = [...selected].filter(entry => !handled.has(JSON.stringify(entry)) && !priceFields.has(entry[0]));
  const pricePresent = price || applied.has("minMinor") || applied.has("maxMinor");
  const precisionHint = `Enter a valid price in ${market.currency} with up to ${market.minorDigits} decimal places.`;

  function choose(field: string, value: string, checked: boolean) {
    setSelected(current => {
      const next = new URLSearchParams(current);
      if (checked) next.append(field, value);
      else next.delete(field, value);
      return next;
    });
  }

  function resetDraft() {
    setSelected(browseParamsWithoutFilters(query));
    setMinimum("");
    setMaximum("");
    setPriceError(undefined);
  }

  function validatePrice(): PriceError | undefined {
    const min = priceInMinor(minimum, market.minorDigits);
    const max = priceInMinor(maximum, market.minorDigits);
    if (minimum && min === undefined) return { side: "minimum", message: precisionHint };
    if (maximum && max === undefined) return { side: "maximum", message: precisionHint };
    if (min !== undefined && max !== undefined && Number(min) > Number(max)) {
      return { side: "maximum", message: "Minimum price must be less than or equal to maximum price." };
    }
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    const error = validatePrice();
    if (error) {
      event.preventDefault();
      setPriceError(error);
      (error.side === "minimum" ? minimumInput : maximumInput).current?.focus();
      return;
    }
    onApply?.();
  }

  return <Form action={path} prefetch={false} className="connected-filter-form" onSubmit={apply}>
    <HiddenFields fields={passThrough} />
    {visible.map(group => <FacetOptions group={group} key={group.id} selected={selected} locale={market.locale} onChoice={choose} />)}
    {pricePresent && <fieldset className="connected-facet connected-facet--price">
      <legend>Price ({market.currency})</legend>
      {price && <p className="connected-facet-range">{formatMoney(price.minMinor, market)} – {formatMoney(price.maxMinor, market)}</p>}
      <input type="hidden" name="priceCurrency" value={market.currency} />
      <div className="connected-facet-price">
        <label>Minimum<input inputMode="decimal" name="minPrice" value={minimum} ref={minimumInput}
          aria-label={`Minimum price in ${market.currency}`} maxLength={14}
          aria-invalid={priceError?.side === "minimum" || undefined} aria-describedby={priceError?.side === "minimum" ? errorId : undefined}
          onChange={event => { setMinimum(event.target.value); setPriceError(undefined); }} /></label>
        <label>Maximum<input inputMode="decimal" name="maxPrice" value={maximum} ref={maximumInput}
          aria-label={`Maximum price in ${market.currency}`} maxLength={14}
          aria-invalid={priceError?.side === "maximum" || undefined} aria-describedby={priceError?.side === "maximum" ? errorId : undefined}
          onChange={event => { setMaximum(event.target.value); setPriceError(undefined); }} /></label>
      </div>
      {priceError && <p id={errorId} role="alert" className="connected-facet-error">{priceError.message}</p>}
      {selected.get("sale") === "false" ? <input type="hidden" name="sale" value="false" /> : <label className="connected-facet-choice">
        <input type="checkbox" name="sale" value="true" checked={selected.get("sale") === "true"}
          onChange={event => choose("sale", "true", event.target.checked)} />
        <span>On sale</span>
      </label>}
    </fieldset>}
    {!pricePresent && selected.has("sale") && <input type="hidden" name="sale" value={selected.get("sale")!} />}
    <div className="connected-filter-actions">
      <button className="button button--primary" type="submit">Apply filters</button>
      {onApply && <button className="button button--outline" type="button" onClick={resetDraft}>Reset filters</button>}
    </div>
  </Form>;
}

export function ConnectedBrowseFilters({ price, ...props }: FilterProps & { price: Price }) {
  const heading = useId();
  const drawerHeading = useId();
  const drawerId = useId();
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const activeCount = [...new URLSearchParams(props.query).keys()].filter(field => filterFields.has(field)).length;
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 759px)");
    const onResize = () => { if (!mobile.matches) drawer.current?.close(); };
    mobile.addEventListener("change", onResize);
    return () => mobile.removeEventListener("change", onResize);
  }, []);
  function closeDrawer() { drawer.current?.close(); }
  return <div className="connected-filter-area">
    <aside className="connected-filter-sidebar" aria-labelledby={heading}>
      <h2 id={heading}>Filters</h2>
      <FilterForm {...props} key={props.query} price={price} />
    </aside>
    <div className="connected-filter-mobile">
      <button className="button button--outline" type="button" ref={trigger} aria-haspopup="dialog"
        aria-controls={drawerId} aria-expanded={open}
        onClick={() => { drawer.current?.showModal(); setOpen(true); }}><SlidersHorizontal aria-hidden="true" size={17} />Filters
        {activeCount > 0 && <span aria-hidden="true" className="connected-filter-active-count">{activeCount.toLocaleString(props.market.locale)}</span>}
      </button>
      <dialog ref={drawer} id={drawerId} className="connected-filter-drawer" aria-labelledby={drawerHeading}
        onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}
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
  const params = firstPageParams(query);
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
  const params = firstPageParams(query);
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
    <Link href={clearBrowseFilters(path, query)} prefetch={false} className="text-link">{clearLabel}</Link>
  </div>;
}

export function ConnectedBrowsePagination({ path, query, page, pageCount, label = "Category result pages" }:
  { path: string; query: string; page: number; pageCount: number; label?: string }) {
  if (pageCount < 2) return null;
  const href = (requested: number) => {
    const params = firstPageParams(query);
    if (requested > 1) params.set("page", String(requested));
    return browseHref(path, params);
  };
  return <nav className="connected-browse-pagination" aria-label={label}>
    {page > 1 && <Link className="button button--outline" href={href(page - 1)} prefetch={false} rel="prev">Previous page</Link>}
    <p aria-current="page">Page {page} of {pageCount}</p>
    {page < pageCount && <Link className="button button--outline" href={href(page + 1)} prefetch={false} rel="next">Next page</Link>}
  </nav>;
}
