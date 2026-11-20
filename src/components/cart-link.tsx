"use client";

import { CircleAlert, ShoppingCart, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState } from "react";
import { formatMoney } from "@/config/markets";
import { localizedStorePath, regionalMarket, withoutRegionalPrefix } from "@/config/regional-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { cartItemKey } from "@/lib/cart/model";
import { useCartPricing } from "./cart-pricing";
import { CartLine } from "./cart-view";
import "./cart-drawer.css";

export function CartLink() {
  const { cart, totalSaved, market, state, refreshing, priceChanged, retry } = useCartPricing();
  const { sync, message } = useCart();
  const { retrySync } = useCartActions();
  const pathname = usePathname();
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const atCart = withoutRegionalPrefix(pathname) === "/cart";
  const path = regionalMarket(pathname) ? localizedStorePath("/cart", market.id) : "/cart";
  const cartHref = `${path}?${new URLSearchParams({ market: market.id, lang: market.locale })}`;
  const affected = cart?.affectedLines ?? 0;
  const attention = affected > 0 ? `Some items need attention in ${market.name}.` : "";
  return (
    <>
      <Link ref={trigger} className="cart-link" data-empty={totalSaved === 0 || undefined} href={cartHref}
        aria-haspopup={atCart ? undefined : "dialog"} aria-expanded={atCart ? undefined : open} aria-controls={atCart ? undefined : id}
        aria-label={`Cart, ${totalSaved} ${totalSaved === 1 ? "item" : "items"}${attention ? `. ${attention}` : ""}`}
        title={attention || undefined}
        onClick={event => {
          if (atCart || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !drawer.current) return;
          event.preventDefault();
          drawer.current.showModal();
          setOpen(true);
          if (state === "priced" && !refreshing) retry();
        }}>
        <ShoppingCart aria-hidden="true" size={21} strokeWidth={1.8} />
        <span aria-hidden="true" className="cart-link__count">{totalSaved}{affected > 0 && <CircleAlert className="cart-link__alert" size={15} />}</span>
        <span role="status" className="sr-only">{attention}</span>
      </Link>
      <dialog ref={drawer} id={id} className="cart-drawer" aria-labelledby={`${id}-title`}
        onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}
        onClick={event => {
          if (event.target === event.currentTarget || (event.target instanceof Element && event.target.closest("a[href]"))) {
            drawer.current?.close();
          }
        }}>
        <header className="cart-drawer__heading">
          <div><h2 id={`${id}-title`}>Your cart</h2><p>{market.name} · {market.currency}</p></div>
          <button type="button" className="button button--outline" aria-label="Close cart" onClick={() => drawer.current?.close()}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        {open && <>
          <div className="cart-drawer__body" aria-busy={state === "loading" || refreshing || sync === "saving"}>
            {(state === "loading" || refreshing) && <p role="status">Checking prices and stock…</p>}
            {!refreshing && priceChanged && <p role="status">An item price changed. Review the updated amounts below.</p>}
            {state === "empty" && <p>Your cart is empty.</p>}
            {state === "error" && !message && <p role="alert">Your cart couldn’t load.</p>}
            {message && sync === "error" && <p role="alert">{message}</p>}
            {sync === "error" && retrySync && <button className="link-button" type="button" onClick={retrySync}>Retry cart sync</button>}
            {state === "error" && !message && <button className="link-button" type="button" onClick={retry}>Retry prices and stock</button>}
            {cart && <ul aria-label="Cart items">
              {cart.lines.map(line => <CartLine key={cartItemKey(line)} line={line} market={market} disabled={refreshing || sync === "saving"} />)}
            </ul>}
          </div>
          <footer className="cart-drawer__footer">
            {cart && cart.lines.length > 0 && <>
              <p className="cart-drawer__subtotal"><span>Merchandise subtotal</span><strong>{formatMoney(cart.subtotalMinor, market)}</strong></p>
              <p>{affected ? "Resolve unavailable items before checkout." : "Delivery and payment eligibility are checked at checkout."}</p>
            </>}
            <Link className="button button--primary" href={cartHref}>View full cart</Link>
          </footer>
        </>}
      </dialog>
    </>
  );
}
