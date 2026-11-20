"use client";

import { AlertCircle, ArrowRight, LoaderCircle, LockKeyhole, ShoppingBag, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { cartItemKey, cartLookupBody, evaluateCart, type CartLineStatus } from "@/lib/cart/model";
import type { CartCatalogItem } from "@/lib/catalog/types";
import { useCartPricing } from "./cart-pricing";
import { QuantityControl } from "./quantity-control";
import { EmptyState } from "./store-ui";

type EvaluatedLine = ReturnType<typeof evaluateCart>["lines"][number];

function describeLine(status: CartLineStatus, market: Market): string | null {
  switch (status) {
    case "not-sold":
    case "removed": return `Unavailable in ${market.name}`;
    case "out-of-stock": return `Out of stock in ${market.name}`;
    case "over-stock": return `Reduce the quantity for ${market.name}`;
    case "personalization": return "Review the listing’s personalization instructions and add the item again.";
    case "offer-changed": return "This saved offer changed. Choose the current offer on the product page.";
    case "duplicate-offer": return "Two saved lines now use the same offer. Remove one line before checkout.";
    default: return null;
  }
}

function CartLine({ line, market, onSave, onRestore }: { line: EvaluatedLine; market: Market;
  onSave?: () => void; onRestore?: () => void }) {
  const { product, variantId, offerId, quantity, stock, variantStock, personalization } = line;
  const { removeFromCart, removeSaved, setCartQuantity } = useCartActions();
  const measurement = { productId: product?.productId, variantId: product?.variantId, offerId: product?.offer?.id, priceMinor: line.unitMinor ?? undefined };
  const summary = product ? `${product.name} — ${product.variantLabel}` : "Unavailable item";
  const label = personalization ? `${summary} (${personalization})` : summary;
  const productHref = product && `/products/${product.slug}?variant=${product.variantId}${offerId ? "&browse=1" : ""}`;
  const status = describeLine(line.status, market);

  return (
    <li className="cart-line" aria-label={label}>
      {product && productHref ? (
        <Link href={productHref} className="cart-line__image" tabIndex={-1} aria-hidden="true">
          <Image src={storefrontPath(product.image.src)} alt={product.image.alt} fill sizes="112px" />
        </Link>
      ) : <div className="cart-line__image cart-line__placeholder"><ShoppingBag aria-hidden="true" size={28} /></div>}
      <div className="cart-line__info">
        <h3>{productHref ? <Link href={productHref}>{product.name}</Link> : label}</h3>
        {product && <p className="cart-line__variant">{product.selectedOptions?.length ?
          product.selectedOptions.map(({ label, value }) => `${label} ${value}`).join(" · ") : product.variantLabel}</p>}
        {product?.sku && offerId && <p className="cart-line__variant">SKU {product.sku}</p>}
        {personalization && <p className="personalization-note">Personalization: {personalization}</p>}
        {line.unitMinor !== null && <p className="cart-line__unit">{formatMoney(line.unitMinor, market)} each</p>}
        {status && <p className="cart-line__status"><AlertCircle aria-hidden="true" size={15} /> {status}</p>}
        {offerId && product?.offer?.id && offerId !== product.offer.id &&
          <p className="cart-line__variant">Price updated for {market.name}.</p>}
        <div className="cart-line__actions">
          {line.status === "available" && !onRestore ? (
            <QuantityControl value={quantity} max={stock} label={`Quantity for ${label}`}
              onChange={(value) => void setCartQuantity(variantId, value, variantStock, personalization, quantity, measurement, offerId)} />
          ) : <span className="cart-line__saved">Saved quantity: {quantity}</span>}
          {!onRestore && line.status === "over-stock" && stock > 0 && (
            <button className="link-button" type="button"
              onClick={() => void setCartQuantity(variantId, stock, variantStock, personalization, quantity, measurement, offerId)}>Set quantity to {stock}</button>
          )}
          {onSave && <button className="link-button" type="button" onClick={onSave}>Save for later</button>}
          {onRestore && <button className="link-button" type="button" onClick={onRestore} disabled={line.status !== "available"}>Move to cart</button>}
          <button className="cart-line__remove" type="button" aria-label={`Remove ${label}`}
            onClick={() => void (onRestore ? removeSaved(variantId, personalization, quantity, measurement, offerId) :
              removeFromCart(variantId, personalization, quantity, measurement, offerId))}>
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

function CartSummary({ market, subtotal, count, checkoutEnabled, affected, production, marketplace }: {
  market: Market; subtotal: number; count: number; checkoutEnabled: boolean; affected: boolean; production: boolean; marketplace: boolean;
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
        <Link className="button button--primary cart-summary__checkout" href="/checkout">{marketplace ? "Proceed to checkout" : "Guest checkout"} <ArrowRight aria-hidden="true" size={17} /></Link>
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

function SavedItems({ market }: { market: Market }) {
  const { saved, ready } = useCart();
  const { restoreSaved } = useCartActions();
  const body = saved.length ? cartLookupBody(saved) : "";
  const key = `${market.id}:${market.locale}:${body}`;
  const [lookup, setLookup] = useState<{ key: string; items?: CartCatalogItem[] }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ready || !body) return;
    const controller = new AbortController();
    void fetch(storefrontPath("/api/cart/resolve"), { method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" }, body,
    }).then(async response => {
      if (!response.ok) throw new Error("Saved items unavailable");
      const result = await response.json();
      if (!controller.signal.aborted) setLookup({ key, items: result.marketId === market.id ? result.items : undefined });
    }).catch(() => { if (!controller.signal.aborted) setLookup({ key }); });
    return () => controller.abort();
  }, [market.id, key, body, ready, attempt]);
  if (!saved.length) return null;
  const active = lookup?.key === key ? lookup : null;
  const catalogItems = active?.items;
  return <section className="cart-items mp-saved" aria-labelledby="saved-heading">
    <h2 id="saved-heading">Saved for later ({saved.length})</h2>
    {error && <p role="alert">{error}</p>}
    {catalogItems ? <ul>{saved.flatMap(item => evaluateCart([item], catalogItems, market).lines).map(line =>
      <CartLine key={cartItemKey(line)} {...{ line, market }} onRestore={async () =>
        setError(await restoreSaved(line.variantId, line.variantStock, line.personalization, line.quantity,
          { productId: line.product?.productId, variantId: line.product?.variantId, offerId: line.product?.offer?.id,
            priceMinor: line.unitMinor ?? undefined }, line.offerId) ? "" : "This item couldn't be moved back to the cart.")}/>)}</ul>
      : active ? <button type="button" className="button button--outline" onClick={() => setAttempt(n => n + 1)}>Reload saved items</button>
        : <p role="status">Checking current prices and stock…</p>}
  </section>;
}

export function CartView({ checkoutEnabled, production, marketplace = false }: { checkoutEnabled: boolean; production: boolean; marketplace?: boolean }) {
  const { market, ready, persistent, totalSaved, state, cart, retry } = useCartPricing();
  const { sync, message } = useCart();
  const { moveToSaved, retrySync } = useCartActions();
  const [moveError, setMoveError] = useState("");
  const syncNotice = sync === "guest" || sync === "loading" ? null : <div className="cart-notice" role="status">
    {sync === "error" ? <><AlertCircle aria-hidden="true" size={20} /> <span>{message}</span>
      <button type="button" className="link-button" onClick={retrySync}>Retry cart sync</button></>
      : sync === "saving" ? "Saving your cart…" : "Your cart is synced to your account."}
  </div>;

  if (state === "loading") {
    return <div className="state-panel" role="status"><LoaderCircle className="spinner" aria-hidden="true" size={22} />{ready ? `Checking prices and availability for ${market.name}…` : "Loading your saved cart…"}</div>;
  }
  if (state === "empty") {
    return (
      <>{syncNotice}<EmptyState title="Your cart is empty" description="Explore the store and add something you’d like to come back to." icon={<ShoppingBag aria-hidden="true" size={27} strokeWidth={1.6} />}>
        <Link className="button button--primary" href="/shop">Explore the catalog <ArrowRight aria-hidden="true" size={17} /></Link>
      </EmptyState>{marketplace && <SavedItems market={market}/>}</>
    );
  }
  if (!cart) {
    return (
      <EmptyState title="We couldn’t load your cart details" description={message ?? "Your items are still saved. Try again to check their prices and availability."} icon={<AlertCircle aria-hidden="true" size={27} />}>
        <button className="button button--primary" type="button" onClick={retry}>Try again</button>
      </EmptyState>
    );
  }

  return (
    <>
      {syncNotice}
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
          <ul>{cart.lines.map(line => <CartLine key={cartItemKey(line)} {...{ line, market }}
            onSave={marketplace ? async () => setMoveError(await moveToSaved(line.variantId, line.personalization, line.quantity,
              { productId: line.product?.productId, variantId: line.product?.variantId, offerId: line.product?.offer?.id,
                priceMinor: line.unitMinor ?? undefined }, line.offerId) ? "" : "This item couldn't be saved for later.") : undefined}/>)}</ul>
        </section>
        <CartSummary market={market} subtotal={cart.subtotalMinor} count={cart.eligibleQuantity} checkoutEnabled={checkoutEnabled} affected={cart.affectedLines > 0} production={production} marketplace={marketplace} />
      </div>
      {marketplace && <SavedItems market={market}/>}
      <Link className="text-link cart-continue" href="/shop">Continue shopping <ArrowRight aria-hidden="true" size={17} /></Link>
    </>
  );
}
