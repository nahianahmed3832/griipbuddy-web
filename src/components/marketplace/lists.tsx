"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Market } from "@/config/markets";
import type { ListSummary } from "@/lib/marketplace/constants";
import type { SavedProduct } from "@/lib/marketplace/saved-product-cards";
import { captureMeasurement } from "@/lib/measurement/browser";
import { ProductGrid, savedParentHref } from "../product-grid";
import { MarketplaceForm, useMarketplaceSubmission } from "./action-form";
import { marketplaceRequest, useMarketplace } from "./session";

export function FavoritesGrid({ products, market, regional }: { products: readonly SavedProduct[]; market: Market; regional: boolean }) {
  const state = useMarketplace()!;
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase(market.locale);
  const rows = products.filter(item => (!item.card || state.favorites.includes(item.id)) &&
    item.name.toLocaleLowerCase(market.locale).includes(search));
  const cards = rows.flatMap(item => item.card ?? []);
  return <>
    {products.length > 0 && <label className="store-dialog__field mp-list-search">Search your favorites<input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>}
    {cards.length > 0 && <ProductGrid cards={cards} market={market} placement={{ placement: "favorites" }} savedParents={{ regional, favorites: true }} />}
    <OtherSavedProducts products={rows} market={market} regional={regional} favorites />
    {!rows.length && <p>{search ? "No favorites match this search." : "Select a heart on a listing to save it here."}</p>}
  </>;
}

export function SavedProductsRetry() {
  const router = useRouter();
  const [pending, refresh] = useTransition();
  return <div className="mp-inline">
    <p role="alert">We couldn’t check your saved product details.</p>
    <button className="button button--outline" type="button" disabled={pending} onClick={() => refresh(() => router.refresh())}>
      {pending ? "Checking…" : "Try again"}
    </button>
  </div>;
}

export function OtherSavedProducts({ products, market, regional, favorites = false, list }: {
  products: readonly SavedProduct[]; market: Market; regional: boolean; favorites?: boolean; list?: string;
}) {
  const remaining = products.filter(item => !item.card);
  if (!remaining.length) return null;
  return <ul className="mp-shop-grid">
    {remaining.map(item => <li className="mp-list-card" key={item.id}>
      {item.slug ? <Link prefetch={false} href={savedParentHref(item.slug, market, regional)}>
        <strong>{item.name}</strong><p>Choose options</p>
      </Link>
      : <><strong>{item.name}</strong><p>{item.archived ? "This product was archived." : `Unavailable in ${market.name}`}</p></>}
      {favorites && <RemoveSavedFavorite item={item} market={market} />}
      {list && <RemoveListItem list={list} item={item} market={market} />}
    </li>)}
  </ul>;
}

function RemoveSavedFavorite({ item, market }: { item: SavedProduct; market: Market }) {
  const marketplace = useMarketplace();
  const state = useMarketplaceSubmission();
  if (!marketplace?.shopper) return null;
  return <div className="mp-form">
    <button className="button button--outline" type="button" disabled={state.pending} onClick={() => {
      const measure = captureMeasurement();
      void state.submit(async () => {
        await marketplace.favorite(item.id, false);
        measure({ action: "WISHLIST_REMOVE", productId: item.id, marketId: market.id, placement: "wishlist" });
      }, "Removed.");
    }}>{state.pending ? "Removing…" : `Remove ${item.name} from favorites`}</button>
    {state.feedback}
  </div>;
}

export function EditList({ list }: { list: ListSummary }) {
  const [copied, setCopied] = useState("");
  return <div className="mp-section">
    <MarketplaceForm key={`${list.name}:${list.public}`} label="Save settings" success="Settings saved." command={form => ({
      action: "edit-list", list: list.id, name: form.get("name"), public: form.has("public"),
    })} fields={<>
      <label>Name<input name="name" defaultValue={list.name} minLength={2} maxLength={60} required/></label>
      <label className="mp-remember"><input type="checkbox" name="public" defaultChecked={list.public}/> Anyone with the link can view</label>
    </>}/>
    {list.public && <div className="mp-inline"><button className="button button--outline" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(location.href); setCopied("Link copied."); }
      catch { setCopied("Copy the page address to share your list."); }
    }}>Copy share link</button>{copied && <p role="status">{copied}</p>}</div>}
    <details className="mp-section"><summary>Delete {list.registry ? "registry" : "collection"}</summary>
      <MarketplaceForm label="Confirm deletion" success="List deleted." command={() => ({ action: "delete-list", list: list.id })}
        navigate={() => list.registry ? "/registry" : "/favorites"}/>
    </details>
  </div>;
}

export function RemoveListItem({ list, item, market }: { list: string; item: SavedProduct; market: Market }) {
  const state = useMarketplaceSubmission();
  return <form className="mp-form" method="post" onSubmit={event => {
      event.preventDefault();
      const measure = captureMeasurement();
      void state.submit(async () => {
        await marketplaceRequest({ action: "list-item", list, product: item.id, selected: false });
        measure({ action: "WISHLIST_REMOVE", productId: item.id, marketId: market.id,
          displayedPriceMinor: item.card?.priceMinor, currency: item.card ? market.currency : undefined, placement: "wishlist" });
      }, "Removed.");
    }}>
    <button className="button button--outline" type="submit" disabled={state.pending}>
      {state.pending ? "Removing…" : `Remove ${item.name}`}
    </button>
    {state.feedback}
  </form>;
}

export function ListLinks({ lists }: { lists: readonly ListSummary[] }) {
  return <div className="mp-shop-grid">{lists.map(list => <Link className="mp-list-card" key={list.id} href={`/lists/${list.id}`}>
    <strong>{list.name}</strong><p>{list.public ? "Shared" : "Private"}</p>
  </Link>)}</div>;
}
