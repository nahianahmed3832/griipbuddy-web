"use client";

import { AlertCircle, ArrowRight, LoaderCircle, LockKeyhole, ShoppingBag, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { localizedStoreHref, marketStoreHref, productLandingPath } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { cartItemKey, cartLineIssue, evaluateCart } from "@/lib/cart/model";
import type { CartCatalogItem } from "@/lib/catalog/types";
import { useCartPricing } from "./cart-pricing";
import { QuantityControl } from "./quantity-control";
import { EmptyState } from "./store-ui";

type EvaluatedLine = ReturnType<typeof evaluateCart>["lines"][number];

function CartLine({ line, market, regionalRouting, onSave, onRestore }: { line: EvaluatedLine; market: Market; regionalRouting: boolean;
  onSave?: () => void; onRestore?: () => void }) {
  const { setCartQuantity, removeSaved, removeFromCart } = useCartActions();
  const { product, variantId, quantity, stock, variantStock, personalization } = line;
  const summary = product ? `${product.name} — ${product.variantLabel}` : "Unavailable item";
  const label = personalization ? `${summary} (${personalization})` : summary;
  const productHref = product && (regionalRouting ? productLandingPath(product.slug, market.id, true, variantId) :
    `/products/${product.slug}?variant=${variantId}`);
  const status = cartLineIssue(line.status, market.name);

  return (
    <li className="cart-line" aria-label={label}>
      {product && productHref ? (
        <Link href={productHref} className="cart-line__image" tabIndex={-1} aria-hidden="true">
          <Image src={storefrontPath(product.image.src)} alt={product.image.alt} fill sizes="112px" />
        </Link>
      ) : <div className="cart-line__image cart-line__placeholder"><ShoppingBag aria-hidden="true" size={28} /></div>}
      <div className="cart-line__info">
        <h3>{productHref ? <Link href={productHref}>{product.name}</Link> : label}</h3>
        {product && <p className="cart-line__variant">{product.variantLabel}</p>}
        {personalization && <p className="personalization-note">Personalization: {personalization}</p>}
        {line.unitMinor !== null && <p className="cart-line__unit">{formatMoney(line.unitMinor, market)} each</p>}
        {status && <p className="cart-line__status"><AlertCircle aria-hidden="true" size={15} /> {status}</p>}
        <div className="cart-line__actions">
          {line.status === "available" && !onRestore ? (
            <QuantityControl value={quantity} max={stock} label={`Quantity for ${label}`}
              onChange={(value) => setCartQuantity(variantId, value, variantStock, personalization)} />
          ) : <span className="cart-line__saved">Saved quantity: {quantity}</span>}
          {!onRestore && line.status === "over-stock" && stock > 0 && (
            <button className="link-button" type="button"
              onClick={() => setCartQuantity(variantId, stock, variantStock, personalization)}>Set quantity to {stock}</button>
          )}
          {onSave && <button className="link-button" type="button" onClick={onSave}>Save for later</button>}
          {onRestore && <button className="link-button" type="button" onClick={onRestore} disabled={line.status !== "available"}>Move to cart</button>}
          <button className="cart-line__remove" type="button" aria-label={`Remove ${label}`}
            onClick={() => onRestore ? removeSaved(variantId, personalization) : removeFromCart(variantId, personalization)}>
            <Trash2 aria-hidden="true" size={15} /> <span>Remove</span>
          </button>
        </div>
      </div>
      <div className="cart-line__total">
        <span>Line total</span>
        <strong>{line.lineMinor !== null ? formatMoney(line.lineMinor, market) : "Excluded"}</strong>
      </div>
    </li>
  );
}

function CartSummary({ market, subtotal, count, checkoutEnabled, checkoutHref, affected, production, marketplace }: {
  market: Market; subtotal: number; count: number; checkoutEnabled: boolean; checkoutHref: string; affected: boolean; production: boolean; marketplace: boolean;
}) {
  return (
    <aside className="cart-summary" aria-labelledby="cart-summary-heading">
      <h2 className="display-type" id="cart-summary-heading">Cart summary</h2>
      <dl>
        <div className="cart-summary__subtotal">
          <dt>Merchandise subtotal <span>{count} eligible {count === 1 ? "item" : "items"}</span></dt>
          <dd aria-live="polite">{formatMoney(subtotal, market)}</dd>
        </div>
        <div><dt>Shipping</dt><dd>Not calculated</dd></div>
        <div><dt>Taxes</dt><dd>Not calculated</dd></div>
      </dl>
      {checkoutEnabled && (!affected || marketplace) ? (
        <Link className="button button--primary cart-summary__checkout" href={checkoutHref}>{marketplace ? "Proceed to checkout" : "Guest checkout"} <ArrowRight aria-hidden="true" size={17} /></Link>
      ) : (
        <button className="button button--primary cart-summary__checkout" disabled type="button">
          <LockKeyhole aria-hidden="true" size={17} /> {checkoutEnabled ? "Resolve unavailable items" : "Checkout unavailable"}
        </button>
      )}
      <p>{checkoutEnabled ? marketplace ? "Choose a shipping country at checkout to see current prices and delivery charges." :
        "Delivery and tax are calculated at checkout." : production ? "Checkout is currently closed." : `Ordering is closed in the ${market.name} preview.`}</p>
    </aside>
  );
}

function SavedItems({ market, regionalRouting }: { market: Market; regionalRouting: boolean }) {
  const { saved, ready } = useCart();
  const { restoreSaved } = useCartActions();
  const ids = [...new Set(saved.map(item => item.variantId))].sort().join(",");
  const key = `${market.id}:${ids}`;
  const [lookup, setLookup] = useState<{ key: string; items?: CartCatalogItem[] }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready || !ids) return;
    const controller = new AbortController();
    void fetch(storefrontPath("/api/cart/resolve"), { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        variantIds: ids.split(","), ...(regionalRouting && { marketId: market.id }),
      }),
    }).then(async response => {
      if (!response.ok) throw new Error("Saved items unavailable");
      const result = await response.json();
      if (!controller.signal.aborted) setLookup({ key, items: result.marketId === market.id ? result.items : undefined });
    }).catch(() => { if (!controller.signal.aborted) setLookup({ key }); });
    return () => controller.abort();
  }, [market.id, key, ids, ready, attempt, regionalRouting]);
  if (!saved.length) return null;
  const active = lookup?.key === key ? lookup : null;
  const catalogItems = active?.items;
  return <section className="cart-items mp-saved" aria-labelledby="saved-heading">
    <h2 id="saved-heading">Saved for later ({saved.length})</h2>
    {error && <p role="alert">{error}</p>}
    {catalogItems ? <ul>{saved.flatMap(item => evaluateCart([item], catalogItems, market).lines).map(line =>
      <CartLine key={cartItemKey(line)} {...{ line, market, regionalRouting }} onRestore={() =>
        setError(restoreSaved(line.variantId, line.variantStock, line.personalization) ? "" : "There isn't enough stock to restore this quantity.")}/>)}</ul>
      : active ? <button type="button" className="button button--outline" onClick={() => setAttempt(n => n + 1)}>Reload saved items</button>
        : <p role="status">Checking current prices and stock…</p>}
  </section>;
}

export function CartView({ checkoutEnabled, production, marketplace = false }: { checkoutEnabled: boolean; production: boolean; marketplace?: boolean }) {
  const { market, regionalRouting, ready, persistent, totalSaved, state, cart, retry } = useCartPricing();
  const { moveToSaved } = useCartActions();
  const [moveError, setMoveError] = useState("");
  const region = regionalRouting ? market.id : undefined;
  const shopHref = marketStoreHref("/shop", region);
  const checkoutHref = region ? localizedStoreHref(`/checkout?destination=${region}`, region) : "/checkout";

  if (state === "loading") {
    return <div className="state-panel" role="status"><LoaderCircle className="spinner" aria-hidden="true" size={22} />{ready ? `Checking prices and availability for ${market.name}…` : "Loading your saved cart…"}</div>;
  }
  if (state === "empty") {
    return (
      <><EmptyState title="Your cart is empty" description="Explore the store and add something you’d like to come back to." icon={<ShoppingBag aria-hidden="true" size={27} strokeWidth={1.6} />}>
        <Link className="button button--primary" href={shopHref}>Explore the catalog <ArrowRight aria-hidden="true" size={17} /></Link>
      </EmptyState>{marketplace && <SavedItems market={market} regionalRouting={regionalRouting}/>}</>
    );
  }
  if (!cart) {
    return (
      <EmptyState title="We couldn’t load your cart details" description="Your items are still saved. Try again to check their prices and availability." icon={<AlertCircle aria-hidden="true" size={27} />}>
        <button className="button button--primary" type="button" onClick={retry}>Try again</button>
      </EmptyState>
    );
  }

  return (
    <>
      {!persistent && <p className="cart-notice" role="status"><AlertCircle aria-hidden="true" size={20} /> Browser storage is unavailable. This cart may reset when you reload.</p>}
      {cart.affectedLines > 0 && (
        <p className="cart-notice" role="status">
          <AlertCircle aria-hidden="true" size={20} />
          <span><strong>Some saved items need attention in {market.name}.</strong> They’re still in your cart and excluded from the subtotal. Adjust the quantity, remove the item, or switch back to your previous market.</span>
        </p>
      )}
      <div className="cart-layout">
        <section className="cart-items" aria-labelledby="cart-items-heading">
          <h2 id="cart-items-heading" aria-live="polite">{totalSaved} {totalSaved === 1 ? "item" : "items"} in your cart</h2>
          {moveError && <p role="alert">{moveError}</p>}
          <ul>{cart.lines.map(line => <CartLine key={cartItemKey(line)} {...{ line, market, regionalRouting }}
            onSave={marketplace ? () => setMoveError(moveToSaved(line.variantId, line.personalization) ? "" : "The saved items list is full.") : undefined}/>)}</ul>
        </section>
        <CartSummary market={market} subtotal={cart.subtotalMinor} count={cart.eligibleQuantity} checkoutEnabled={checkoutEnabled} checkoutHref={checkoutHref}
          affected={cart.affectedLines > 0} production={production} marketplace={marketplace} />
      </div>
      {marketplace && <SavedItems market={market} regionalRouting={regionalRouting}/>}
      <Link className="text-link cart-continue" href={shopHref}>Continue shopping <ArrowRight aria-hidden="true" size={17} /></Link>
    </>
  );
}
