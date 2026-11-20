"use client";

import Image from "next/image";
import Link from "next/link";
import { Ruler, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { MeasuredProductLink } from "./measurement-observers";
import type { CatalogImage, ListedVariant, Specification } from "@/lib/catalog/types";
import "./retail-product.css";

export function RetailOptions({ names, variants, selected, guides, onSelect, canSelect }: {
  names: string[];
  variants: readonly ListedVariant[];
  selected: ListedVariant;
  guides: readonly Specification[];
  onSelect: (name: string, value: string) => void;
  canSelect: (name: string, value: string) => boolean;
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
            const valid = canSelect(name, value);
            const available = valid && scoped.some(item => (item.offer?.stock ?? 0) > 0);
            return <button type="button" key={value} onClick={() => onSelect(name, value)}
              aria-pressed={selected.options[name] === value} aria-label={`${value}${available ? "" : ", unavailable"}`}
              disabled={!valid || kind === "size" && !available} data-available={available} title={value}>
              {image ? <Image src={storefrontPath(image.src)} alt="" width={64} height={74} unoptimized/> : value}
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

export type ProductAddOn = { id: string; variantId: string; name: string; slug: string; image: CatalogImage; priceMinor: number; stock: number;
  recommendationVersion?: string };

export function ProductAddOns({ entries, market }: { entries: readonly ProductAddOn[]; market: Market }) {
  const { ready, sync } = useCart();
  const { addToCart } = useCartActions();
  const [message, setMessage] = useState("");
  if (!entries.length) return null;
  return <section className="retail-addons" aria-label="Complete your setup">
    <h2>Complete your setup</h2>
    <ul>{entries.map((entry, index) => <li key={entry.variantId}>
      <MeasuredProductLink card={entry} market={market} context={{ placement: "complementary", position: index + 1, recommendationVersion: entry.recommendationVersion }}
        href={`/products/${entry.slug}?variant=${entry.variantId}`}>
        <Image src={storefrontPath(entry.image.src)} alt={entry.image.alt} width={52} height={52} unoptimized/>
        <span>{entry.name}<strong>{formatMoney(entry.priceMinor, market)}</strong></span>
      </MeasuredProductLink>
      <button className="button button--outline" type="button" disabled={!ready || sync === "saving"} aria-label={`Add ${entry.name}`}
        onClick={async () => setMessage(await addToCart(entry.variantId, 1, entry.stock, undefined,
          { productId: entry.id, priceMinor: entry.priceMinor, placement: "product-add-ons" }) ? `Added ${entry.name}.` : "Review your cart and try again.")}>Add</button>
    </li>)}</ul>
    {message && <p role="status">{message} <Link href="/cart">View cart</Link></p>}
  </section>;
}
