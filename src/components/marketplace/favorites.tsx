"use client";

import { Heart, ListPlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { ListSummary, ShopSummary } from "@/lib/marketplace/constants";
import { marketplaceRequest, useMarketplace } from "./session";

export function FavoriteButton({ product, name }: { product: string; name: string }) {
  const state = useMarketplace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = state?.favorites.includes(product) ?? false;
  if (!state) return null;
  const label = selected ? `Remove ${name} from favorites` : `Add ${name} to favorites`;
  async function save() {
    if (!state?.shopper) return state?.openAuth();
    setBusy(true);
    setError("");
    try { await state.favorite(product, !selected); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn't update favorites."); }
    finally { setBusy(false); }
  }
  return <div className="mp-favorite">
    <button className="mp-icon" title={label} type="button" aria-label={label} aria-pressed={selected} disabled={busy} onClick={() => void save()}>
      <Heart size={21} fill={selected ? "currentColor" : "none"}/>
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function FollowShop({ shop }: { shop: ShopSummary }) {
  const state = useMarketplace()!;
  const selected = state.shops.some(row => row.id === shop.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div>
    <button className="button button--outline" disabled={busy} type="button" aria-pressed={selected} onClick={async () => {
      if (!state.shopper) return state.openAuth();
      setBusy(true);
      setError("");
      try { await state.follow(shop, !selected); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "Try again shortly."); }
      finally { setBusy(false); }
    }}><Heart size={18} fill={selected ? "currentColor" : "none"}/> {selected ? "Following shop" : "Follow shop"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function AddToList({ product }: { product: string }) {
  const state = useMarketplace()!;
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(""); setFailed(false); setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      const list = state.lists.find(item => item.id === form.get("list"));
      if (!list) throw new Error("Choose a collection or registry.");
      await marketplaceRequest({ action: "list-item", list: list.id, product, selected: true });
      setMessage(`Saved to ${list.name}.`);
      router.refresh();
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Couldn't save the item."); }
    finally { setPending(false); }
  }
  return <>
    <button className="button button--outline" type="button" onClick={() => {
      if (!state.shopper) return state.openAuth();
      setMessage(""); dialog.current?.showModal();
    }}><ListPlus size={18}/> Add to collection or registry</button>
    <dialog className="store-dialog mp-sign-in" ref={dialog} aria-label="Save this item">
      <button className="mp-dialog-close" type="button" aria-label="Close" onClick={() => dialog.current?.close()}><X size={20}/></button>
      <h2>Save this item</h2>
      {state.lists.length ? <form className="store-dialog__fields" onSubmit={add}>
        <label className="store-dialog__field">Collection or registry<select name="list" required>
          {state.lists.map(item => <option key={item.id} value={item.id}>{item.name}{item.registry ? " · Registry" : ""}</option>)}
        </select></label>
        <button className="button button--primary" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      </form> : <p className="store-dialog__description">Create a <Link href="/favorites" onClick={() => dialog.current?.close()}>collection</Link> or a <Link href="/registry" onClick={() => dialog.current?.close()}>registry</Link> first.</p>}
      {message && <p role={failed ? "alert" : "status"}>{message}</p>}
    </dialog>
  </>;
}

export function CreateList({ registry }: { registry: boolean }) {
  const state = useMarketplace()!;
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  return <form className="mp-inline" onSubmit={async event => {
    event.preventDefault();
    if (!state.shopper) return state.openAuth();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    setMessage(""); setPending(true);
    try {
      const list = await marketplaceRequest<ListSummary>({ action: "create-list", registry, name });
      router.push(`/lists/${list.id}`);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Couldn't create the list."); }
    finally { setPending(false); }
  }}>
    <label className="store-dialog__field">{registry ? "Registry name" : "Collection name"}<input name="name" minLength={2} maxLength={60} required /></label>
    <button className="button button--primary" disabled={pending}>{registry ? "Create registry" : "Create collection"}</button>
    {message && <p role="alert">{message}</p>}
  </form>;
}
