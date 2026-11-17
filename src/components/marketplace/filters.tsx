"use client";

import Form from "next/form";
import Link from "next/link";
import { SlidersHorizontal, X } from "lucide-react";
import { useRef } from "react";
import type { Currency, MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { type listingView, sortOptions } from "@/lib/catalog/listing";

type ListingView = ReturnType<typeof listingView>;
type FilterView = Omit<ListingView, "cards" | "active" | "departmentChoices" | "devices"> & {
  resultCount: number;
  departmentChoices: Pick<ListingView["departmentChoices"][number], "id" | "slug" | "shortName">[];
  devices: Pick<ListingView["devices"][number], "id" | "name">[];
};

export function MarketplaceFilters({ path, query, view, currency, region }: { path: string; query?: string; view: FilterView; currency: Currency; region?: MarketId }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const reset = marketStoreHref(query ? `${path}?q=${encodeURIComponent(query)}` : path, region);
  const values = new URLSearchParams();
  if (query) values.set("q", query);
  if (region === "us") values.set("market", region);
  if (view.department) values.set("department", view.department);
  if (view.color) values.set("color", view.color);
  if (view.device) values.set("device", view.device);
  if (view.shop) values.set("shop", view.shop);
  if (view.inStock) values.set("availability", "in-stock");
  if (view.sale) values.set("offer", "sale");
  if (view.min) values.set("min", view.min);
  if (view.max) values.set("max", view.max);
  values.set("sort", view.sort);
  function chip(field: string, value: string) {
    const search = new URLSearchParams(values);
    if (search.get(field) === value) search.delete(field); else search.set(field, value);
    return `${path}?${search}`;
  }
  const activeCount = [view.department, view.color, view.device, view.shop, view.inStock, view.sale, view.min || view.max].filter(Boolean).length;
  return <div className="mp-listing-controls">
    <div className="mp-filter-chips">
      <button type="button" className="button button--outline" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>
        <SlidersHorizontal size={18}/> Show filters{activeCount > 0 && ` (${activeCount})`}
      </button>
      <Link data-selected={view.inStock} href={chip("availability", "in-stock")}>In stock</Link>
      <Link data-selected={view.sale} href={chip("offer", "sale")}>On sale</Link>
      {view.device && <Link data-selected href={chip("device", view.device)} aria-label="Remove phone model filter">
        {view.devices.find(device => device.id === view.device)?.name} <X size={14} aria-hidden="true"/>
      </Link>}
      {view.departmentChoices.slice(0, 3).map(department => <Link key={department.id} data-selected={view.department === department.slug}
        href={chip("department", department.slug)}>{department.shortName}</Link>)}
    </div>
    <div className="mp-sort-row"><p>{view.resultCount} {view.resultCount === 1 ? "result" : "results"}{activeCount > 0 && <Link href={reset}>Clear filters</Link>}</p>
      <Form action={path} className="mp-sort" aria-label="Sort results">
        {[...values].filter(([name]) => name !== "sort").map(([name, value]) => <input key={name} type="hidden" name={name} value={value}/>)}
        <label>Sort by <select name="sort" value={view.sort} onChange={event => event.currentTarget.form?.requestSubmit()}>
          {sortOptions.map(([id, label]) => <option key={id} value={id}>{id === "recommended" ? "Relevancy" : label}</option>)}
        </select></label>
      </Form>
    </div>
    <dialog className="mp-filter-drawer" aria-labelledby="mp-filter-title" ref={dialog}>
      <div className="mp-drawer-title"><h2 id="mp-filter-title">Filters</h2><button className="mp-icon" type="button" aria-label="Close filters" onClick={() => dialog.current?.close()}><X size={21}/></button></div>
      <Form action={path} className="store-dialog__fields" onSubmit={() => dialog.current?.close()}>
        {query && <input type="hidden" name="q" value={query}/>}
        {region === "us" && <input type="hidden" name="market" value={region}/>}
        <input type="hidden" name="sort" value={view.sort}/>
        <fieldset className="mp-price-fields"><legend>Price ({currency})</legend>
          <label className="store-dialog__field">Min<input name="min" type="number" min="0" max="9999999" step="0.01" defaultValue={view.min} placeholder="0"/></label>
          <label className="store-dialog__field">Max<input name="max" type="number" min="0" max="9999999" step="0.01" defaultValue={view.max} placeholder="Any price"/></label>
        </fieldset>
        {view.departmentChoices.length > 0 && <label className="store-dialog__field">Category<select name="department" defaultValue={view.department}>
          <option value="">All categories</option>{view.departmentChoices.map(department => <option key={department.id} value={department.slug}>{department.shortName}</option>)}
        </select></label>}
        {view.colors.length > 0 && <label className="store-dialog__field">Color<select name="color" defaultValue={view.color}>
          <option value="">Any color</option>{view.colors.map(color => <option key={color}>{color}</option>)}
        </select></label>}
        {view.devices.length > 0 && <label className="store-dialog__field">Phone model<select name="device" defaultValue={view.device}>
          <option value="">All models</option>{view.devices.map(device => <option value={device.id} key={device.id}>{device.name}</option>)}
        </select></label>}
        {view.shops.length > 1 && <label className="store-dialog__field">Shop<select name="shop" defaultValue={view.shop}>
          <option value="">All shops</option>{view.shops.map(shop => <option key={shop.id} value={shop.slug}>{shop.name}</option>)}
        </select></label>}
        <label className="mp-remember"><input type="checkbox" name="availability" value="in-stock" defaultChecked={view.inStock}/> In stock</label>
        <label className="mp-remember"><input type="checkbox" name="offer" value="sale" defaultChecked={view.sale}/> On sale</label>
        <div className="mp-drawer-actions"><Link className="button button--outline" href={reset} onClick={() => dialog.current?.close()}>Clear filters</Link>
          <button className="button button--primary">Show results</button></div>
      </Form>
    </dialog>
  </div>;
}
