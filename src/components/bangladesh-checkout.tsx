"use client";

import Link from "next/link";
import type { Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { checkoutStep, useCheckoutMeasurement, useForegroundObservation } from "@/lib/measurement/browser";
import { useCartPricing } from "./cart-pricing";

export function BangladeshCheckout({ market }: { market: Market }) {
  const { state, cart, retry } = useCartPricing();
  useCheckoutMeasurement(state === "priced" && !!cart?.lines.length && cart.affectedLines === 0 &&
    cart.lines.every(({ quantity }) => quantity <= 5), market.id);
  useForegroundObservation("handoff-unavailable", state === "error" ||
    Boolean(cart?.affectedLines || cart?.lines.some(({ quantity }) => quantity > 5)),
  () => checkoutStep(market.id, "HANDOFF", "UNAVAILABLE"));
  if (state === "loading") return <p className="state-panel" role="status">Checking your cart…</p>;
  if (state === "error") return <div className="state-panel">
    <p>We couldn’t check your cart. Your items are still saved.</p>
    <button className="button button--outline" type="button" onClick={retry}>Try again</button>
  </div>;
  if (!cart?.lines.length || cart.affectedLines > 0) return <div className="state-panel">
    <p>{cart?.affectedLines ? "Review the unavailable items in your cart before checking out." : "Your cart is empty."}</p>
    <Link className="button button--primary" href={cart?.affectedLines ? "/cart" : "/shop"}>{cart?.affectedLines ? "Back to cart" : "Browse products"}</Link>
  </div>;
  if (cart.lines.some(({ quantity }) => quantity > 5)) return <div className="state-panel">
    <p>{market.name} checkout supports up to five units of each variant. Adjust the quantity in your cart to continue.</p>
    <Link className="button button--primary" href="/cart">Back to cart</Link>
  </div>;
  const items = cart.lines.map(({ variantId, quantity }) => ({ variantId, quantity }));
  return <form className="commerce-panel commerce-form" method="post" action={storefrontPath("/api/bangladesh-checkout")} onSubmit={() => checkoutStep(market.id, "HANDOFF")}>
    <input name="items" type="hidden" value={JSON.stringify(items)} />
    <p>Enter your delivery address and choose Cash on Delivery at checkout on griipbuddy.com.</p>
    <button className="button button--primary" type="submit">Continue to {market.name} checkout</button>
  </form>;
}
