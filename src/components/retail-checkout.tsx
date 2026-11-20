"use client";

import { useState, type ComponentProps } from "react";
import Link from "next/link";
import { isMarketId, type Market } from "@/config/markets";
import { usePendingCheckout } from "@/lib/cart/checkout-attempt";
import { checkoutStep, useForegroundObservation } from "@/lib/measurement/browser";
import { CheckoutView } from "./checkout-view";
import { PaypalCheckout, usePendingPaypal } from "./paypal-checkout";

type NativeProps = ComponentProps<typeof CheckoutView>;
type PaypalProps = ComponentProps<typeof PaypalCheckout>;

export function RetailCheckout({ market, destinations, directRequested, native, paypal }: {
  market: Market;
  destinations: readonly Pick<Market, "id" | "name">[];
  directRequested: boolean;
  native: NativeProps;
  paypal?: Omit<PaypalProps, "destinationControl" | "onCallbackCleared">;
}) {
  const [method, setMethod] = useState<"native" | "paypal">("native");
  const [callback, setCallback] = useState(paypal?.callback);
  const pendingNative = usePendingCheckout(market.id);
  const pendingPaypal = usePendingPaypal(market.id);
  const nativeAvailable = native.choices.length > 0 || Boolean(native.prepaidChoices?.length);
  const showPaypal = Boolean(paypal) && !pendingNative && !native.prepaidAttempt &&
    (Boolean(callback || pendingPaypal) || !nativeAvailable || method === "paypal");
  const eligible = Boolean(native.directItem || !directRequested || pendingNative || pendingPaypal || callback || native.prepaidAttempt);
  useForegroundObservation(`${market.id}-direct-item-unavailable`, !eligible,
    () => checkoutStep(market.id, "DELIVERY_PAYMENT", "UNAVAILABLE"));

  const controls = <>
    {destinations.length > 1 && <label className="store-dialog__field">Shipping country
      <select autoComplete="country" value={market.id} onChange={event => {
        const next = event.target.value;
        if (!isMarketId(next) || !destinations.some(option => option.id === next)) return;
        const url = new URL(window.location.href);
        url.searchParams.delete("destination");
        url.searchParams.set("market", next);
        window.location.assign(url);
      }}>
        {destinations.map(option => <option value={option.id} key={option.id}>{option.name}</option>)}
      </select>
    </label>}
    {nativeAvailable && paypal?.quoteEnabled && !pendingNative && !pendingPaypal && !callback && !native.prepaidAttempt &&
      <label className="store-dialog__field">Payment route
        <select value={method} onChange={event => setMethod(event.target.value === "paypal" ? "paypal" : "native")}>
          <option value="native">Store checkout</option>
          <option value="paypal">PayPal</option>
        </select>
      </label>}
  </>;

  if (eligible && showPaypal && paypal) {
    return <PaypalCheckout {...paypal} callback={callback}
      onCallbackCleared={() => setCallback(undefined)} destinationControl={controls} />;
  }
  if (eligible) return <CheckoutView {...native} destinationControl={controls} />;
  return <div className="commerce-panel commerce-form">
    {controls}
    <p>This item or quantity is unavailable for the selected shipping country.</p>
    <Link className="button button--outline" href="/shop">Continue shopping</Link>
  </div>;
}
