"use client";

import Link from "next/link";
import { Ruler, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import type { CatalogImage, ListedVariant, Specification } from "@/lib/catalog/types";
import { CatalogPhoto } from "./catalog-photo";
import "./retail-product.css";

export function RetailOptions({ names, variants, selected, guides, onSelect }: {
  names: string[];
  variants: readonly ListedVariant[];
  selected: ListedVariant;
  guides: readonly Specification[];
  onSelect: (name: string, value: string) => void;
}) {
  const guide = useRef<HTMLDialogElement>(null);
  const guideId = useId();
  return <div className="retail-options">
    {names.map(name => {
      const kind = name.toLowerCase();
      const options = [...new Set(variants.flatMap(variant => variant.options[name] ? [variant.options[name]] : []))];
      return <fieldset key={name} className="retail-option-group">
        <legend>{name}{selected.options[name] && <span> {selected.options[name]}</span>}</legend>
        <div className={kind === "color" ? "retail-swatch-grid" : "retail-option-buttons"}>
          {options.map(value => {
            const matching = variants.filter(item => item.options[name] === value);
            const exact = matching.filter(item => Object.entries(selected.options)
              .every(([key, choice]) => key === name || item.options[key] === choice));
            const scoped = kind === "size" && Object.keys(selected.options).some(key => key.toLowerCase() === "color") ? exact : matching;
            const image = kind === "color" ? (
              exact.find(item => Boolean(item.image))?.image ?? matching.find(item => Boolean(item.image))?.image
            ) : undefined;
            const available = scoped.some(item => (item.offer?.stock ?? 0) > 0);
            return <button type="button" key={value} onClick={() => onSelect(name, value)}
              aria-pressed={selected.options[name] === value} aria-label={`${value}${available ? "" : ", unavailable"}`}
              disabled={kind === "size" && !available} data-available={available} title={value}>
              {image ? <CatalogPhoto image={{ ...image, alt: "" }} responsive rendition="thumbnail" width={64} height={74} /> : value}
            </button>;
          })}
        </div>
      </fieldset>;
    })}
    {guides.length > 0 && <button type="button" className="retail-size-guide" aria-haspopup="dialog" onClick={() => guide.current?.showModal()}>
      <Ruler size={18} aria-hidden="true"/> Size guide
    </button>}
    <dialog ref={guide} className="store-dialog" aria-labelledby={guideId}>
      <button type="button" className="store-dialog__close" aria-label="Close size guide" onClick={() => guide.current?.close()}><X size={20}/></button>
      <h2 id={guideId}>Size guide</h2>
      <p>Garment measurements</p>
      <dl className="specifications">{guides.map(({label, value}) => <div key={label}><dt>{label.replace(/^Size guide\s*[:–-]\s*/i, "")}</dt><dd>{value}</dd></div>)}</dl>
    </dialog>
  </div>;
}

export type ProductAddOn = { variantId: string; name: string; slug: string; image: CatalogImage; priceMinor: number; stock: number };

export function ProductAddOns({ entries, market }: { entries: readonly ProductAddOn[]; market: Market }) {
  const { ready } = useCart();
  const { addToCart } = useCartActions();
  const [message, setMessage] = useState("");
  if (!entries.length) return null;
  return <section className="retail-addons" aria-label="Complete your setup">
    <h2>Complete your setup</h2>
    <ul>{entries.map(entry => <li key={entry.variantId}>
      <Link href={marketStoreHref(`/products/${encodeURIComponent(entry.slug)}?${new URLSearchParams({ variant: entry.variantId })}`, market.id)}>
        <CatalogPhoto image={entry.image} responsive rendition="thumbnail" width={52} height={52} />
        <span>{entry.name}<strong>{formatMoney(entry.priceMinor, market)}</strong></span>
      </Link>
      <button className="button button--outline" type="button" disabled={!ready} aria-label={`Add ${entry.name}`}
        onClick={() => setMessage(addToCart(entry.variantId, 1, entry.stock) ? `Added ${entry.name}.` : "Check the quantity already in your cart.")}>Add</button>
    </li>)}</ul>
    {message && <p role="status">{message} <Link href={marketStoreHref("/cart", market.id)}>View cart</Link></p>}
  </section>;
}
