"use client";

import { AlertCircle, ArrowRight, LoaderCircle, LockKeyhole, ShoppingBag, Trash2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { localizedStorePath, regionalMarket } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { cartItemKey, cartLookupBody, evaluateCart, type CartLineStatus } from "@/lib/cart/model";
import type { CartCatalogItem } from "@/lib/catalog/types";
import { lookupCartPrices, useCartPricing } from "./cart-pricing";
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

export function CartLine({ line, market, disabled, onSave, onRestore }: { line: EvaluatedLine; market: Market; disabled: boolean;
  onSave?: () => void; onRestore?: () => void }) {
  const { product, variantId, offerId, quantity, stock, variantStock, personalization } = line;
  const { removeFromCart, removeSaved, setCartQuantity } = useCartActions();
  const pathname = usePathname();
  const changing = useRef(false);
  const [updating, setUpdating] = useState(false);
  const [failedAtQuantity, setFailedAtQuantity] = useState<number>();
  const offer = product?.offer?.marketId === market.id && product.offer.currency === market.currency ? product.offer : null;
  const priceBeforeDiscount = offer?.regularMinor;
  const measurement = { productId: product?.productId, variantId: product?.variantId, offerId: offer?.id, priceMinor: line.unitMinor ?? undefined };
  const summary = product ? `${product.name} — ${product.variantLabel}` : "Unavailable item";
  const label = personalization ? `${summary} (${personalization})` : summary;
  let productHref: string | undefined;
  if (product) {
    const path = `/products/${encodeURIComponent(product.slug)}`;
    const params = new URLSearchParams({ market: market.id, lang: market.locale, variant: product.variantId });
    if (offerId) params.set("browse", "1");
    productHref = `${regionalMarket(pathname) ? localizedStorePath(path, market.id) : path}?${params}`;
  }
  const status = describeLine(line.status, market);
  const busy = updating || disabled;

  async function changeQuantity(value: number) {
    if (changing.current || disabled) return;
    changing.current = true;
    setUpdating(true);
    try {
      const resolved = product && offer?.id ? { variantId: product.variantId, offerId: offer.id } : undefined;
      const updated = await setCartQuantity(variantId, value, variantStock, personalization, quantity, measurement, offerId, resolved);
      setFailedAtQuantity(updated ? undefined : quantity);
    } catch {
      setFailedAtQuantity(quantity);
    } finally {
      changing.current = false;
      setUpdating(false);
    }
  }

  return (
    <li className="cart-line" aria-label={label}>
      {product && productHref ? (
        <Link href={productHref} className="cart-line__image" tabIndex={-1} aria-hidden="true">
          <Image src={storefrontPath(product.image.src)} alt={product.image.alt} fill sizes="112px" unoptimized={product.image.src.startsWith("/media/")} />
        </Link>
      ) : <div className="cart-line__image cart-line__placeholder"><ShoppingBag aria-hidden="true" size={28} /></div>}
      <div className="cart-line__info">
        <h3>{product && productHref ? <Link href={productHref}>{product.name}</Link> : label}</h3>
        {product && <p className="cart-line__variant">{product.selectedOptions?.length ?
          product.selectedOptions.map(({ label, value }) => `${label} ${value}`).join(" · ") : product.variantLabel}</p>}
        {product?.sku && offerId && <p className="cart-line__variant">SKU {product.sku}</p>}
        {personalization && <p className="personalization-note">Personalization: {personalization}</p>}
        {line.unitMinor !== null && <p className="cart-line__unit">
          {typeof priceBeforeDiscount === "number" && priceBeforeDiscount > line.unitMinor && <>
            <span className="sr-only">Regular unit price </span><del>{formatMoney(priceBeforeDiscount, market)}</del>{" "}
          </>}
          {formatMoney(line.unitMinor, market)} each
        </p>}
        {status && <p className="cart-line__status"><AlertCircle aria-hidden="true" size={15} /> {status}</p>}
        {offerId && offer?.id && offerId !== offer.id && <p className="cart-line__variant">Price reflects the current offer for {market.name}.</p>}
        {failedAtQuantity === quantity && <p className="cart-line__status" role="alert">Quantity couldn’t be updated. Recheck prices and stock or try again.</p>}
        <div className="cart-line__actions">
          {line.status === "available" && !onRestore ? (
            <QuantityControl value={quantity} max={stock} disabled={busy} label={`Quantity for ${label}`} onChange={value => void changeQuantity(value)} />
          ) : <span className="cart-line__saved">Saved quantity: {quantity}</span>}
          {!onRestore && line.status === "over-stock" && stock > 0 && (
            <button className="link-button" type="button" disabled={busy} onClick={() => void changeQuantity(stock)}>Set quantity to {stock}</button>
          )}
          {onSave && <button className="link-button" type="button" onClick={onSave} disabled={busy}>Save for later</button>}
          {onRestore && <button className="link-button" type="button" onClick={onRestore} disabled={busy || line.status !== "available"}>Move to cart</button>}
          <button className="cart-line__remove" type="button" aria-label={`Remove ${label}`} disabled={busy}
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

function CartSummary({ market, subtotal, count, checkoutEnabled, pending, affected, production, marketplace }: {
  market: Market; subtotal: number; count: number; checkoutEnabled: boolean; pending: boolean; affected: boolean; production: boolean; marketplace: boolean;
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
      {checkoutEnabled && !pending && (!affected || marketplace) ? (
        <Link className="button button--primary cart-summary__checkout" href="/checkout">{marketplace ? "Proceed to checkout" : "Guest checkout"} <ArrowRight aria-hidden="true" size={17} /></Link>
      ) : (
        <button className="button button--primary cart-summary__checkout" disabled type="button">
          <LockKeyhole aria-hidden="true" size={17} /> {checkoutEnabled ? pending ? "Checking your cart" : "Resolve unavailable items" : "Checkout unavailable"}
        </button>
      )}
      <p>{checkoutEnabled ? marketplace ? "Choose a shipping country at checkout to see current prices and delivery charges." :
        "Delivery and tax are calculated at checkout." : production ? "Checkout is currently closed." : `Ordering is closed in the ${market.name} preview.`}</p>
    </aside>
  );
}

function SavedItems({ market }: { market: Market }) {
  const { saved, ready, sync } = useCart();
  const { restoreSaved } = useCartActions();
  const body = saved.length ? cartLookupBody(saved) : "";
  const [attempt, setAttempt] = useState(0);
  const key = `${market.id}:${market.locale}:${body}:${attempt}`;
  const [lookup, setLookup] = useState<{ key: string; items?: CartCatalogItem[] }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!ready || !body) return;
    const controller = new AbortController();
    void lookupCartPrices(body, market.id, controller.signal).then(items => {
      if (!controller.signal.aborted) setLookup({ key, items });
    }).catch(() => { if (!controller.signal.aborted) setLookup({ key }); });
    return () => controller.abort();
  }, [market.id, key, body, ready]);
  if (!saved.length) return null;
  const active = lookup?.key === key ? lookup : null;
  const catalogItems = active?.items;
  return <section className="cart-items mp-saved" aria-labelledby="saved-heading">
    <h2 id="saved-heading">Saved for later ({saved.length})</h2>
    {error && <p role="alert">{error}</p>}
    {catalogItems ? <ul>{saved.flatMap(item => evaluateCart([item], catalogItems, market).lines).map(line =>
      <CartLine key={cartItemKey(line)} {...{ line, market }} disabled={sync === "saving"} onRestore={async () =>
        setError(await restoreSaved(line.variantId, line.variantStock, line.personalization, line.quantity,
          { productId: line.product?.productId, variantId: line.product?.variantId, offerId: line.product?.offer?.id,
            priceMinor: line.unitMinor ?? undefined }, line.offerId) ? "" : "This item couldn't be moved back to the cart.")}/>)}</ul>
      : active ? <button type="button" className="button button--outline" onClick={() => setAttempt(n => n + 1)}>Reload saved items</button>
        : <p role="status">Checking current prices and stock…</p>}
  </section>;
}

export function CartView({ checkoutEnabled, production, marketplace = false }: { checkoutEnabled: boolean; production: boolean; marketplace?: boolean }) {
  const { market, ready, persistent, totalSaved, state, refreshing, priceChanged, cart, retry } = useCartPricing();
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
          <button type="button" className="link-button" aria-disabled={refreshing} onClick={() => { if (!refreshing) retry(); }}>
            Recheck prices and stock
          </button>
          {refreshing ? <p role="status">Checking prices and stock for {market.name}…</p> :
            priceChanged && <p role="status">Some prices changed. Review the updated subtotal before checkout.</p>}
          {moveError && <p role="alert">{moveError}</p>}
          <ul>{cart.lines.map(line => <CartLine key={cartItemKey(line)} {...{ line, market }} disabled={refreshing || sync === "saving"}
            onSave={marketplace ? async () => setMoveError(await moveToSaved(line.variantId, line.personalization, line.quantity,
              { productId: line.product?.productId, variantId: line.product?.variantId, offerId: line.product?.offer?.id,
                priceMinor: line.unitMinor ?? undefined }, line.offerId) ? "" : "This item couldn't be saved for later.") : undefined}/>)}</ul>
        </section>
        <CartSummary market={market} subtotal={cart.subtotalMinor} count={cart.eligibleQuantity} checkoutEnabled={checkoutEnabled}
          pending={refreshing || sync === "saving"} affected={cart.affectedLines > 0} production={production} marketplace={marketplace} />
      </div>
      {marketplace && <SavedItems market={market}/>}
      <Link className="text-link cart-continue" href="/shop">Continue shopping <ArrowRight aria-hidden="true" size={17} /></Link>
    </>
  );
}
