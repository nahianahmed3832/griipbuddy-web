"use client";

import Link from "next/link";
import { useState } from "react";
import type { Market } from "@/config/markets";
import type { ProductCardData } from "@/lib/catalog/listing";
import type { ListSummary } from "@/lib/marketplace/constants";
import { ProductGrid } from "../product-grid";
import { MarketplaceForm } from "./action-form";
import { useMarketplace } from "./session";

export function FavoritesGrid({ cards, market }: { cards: readonly ProductCardData[]; market: Market }) {
  const state = useMarketplace()!;
  const [query, setQuery] = useState("");
  const rows = cards.filter(card => state.favorites.includes(card.id) && card.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    {cards.length > 0 && <label className="store-dialog__field mp-list-search">Search your favorites<input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>}
    {rows.length ? <ProductGrid cards={rows} market={market}/> : <p>{query ? "No favorites match this search." : "Select a heart on a listing to save it here."}</p>}
  </>;
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

export function RemoveListItem({ list, product, name }: { list: string; product: string; name: string }) {
  return <MarketplaceForm label={`Remove ${name}`} success="Removed." command={() => ({ action: "list-item", list, product, selected: false })}/>;
}

export function ListLinks({ lists }: { lists: readonly ListSummary[] }) {
  return <div className="mp-shop-grid">{lists.map(list => <Link className="mp-list-card" key={list.id} href={`/lists/${list.id}`}>
    <strong>{list.name}</strong><p>{list.public ? "Shared" : "Private"}</p>
  </Link>)}</div>;
}
