"use client";

import { useEffect, useRef, useState, useTransition, type ComponentProps, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatMoney, markets, type MarketId } from "@/config/markets";
import { localizedStorePath } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { usePendingCheckout } from "@/lib/cart/checkout-attempt";
import { cartItemKey, cartLineIssue } from "@/lib/cart/model";
import { checkoutContact, type CheckoutContactBinding } from "@/lib/commerce/checkout-contact";
import type { DirectCheckoutPreview } from "@/lib/commerce/checkout-market";
import { useCartPricing } from "./cart-pricing";
import { CheckoutView } from "./checkout-view";
import { PaypalCheckout, usePendingPaypal } from "./paypal-checkout";
import Link from "next/link";

type DirectPreview = { directPreview?: DirectCheckoutPreview };
type BangladeshProps = ComponentProps<typeof CheckoutView> & DirectPreview;
type PaypalProps = ComponentProps<typeof PaypalCheckout>;

type CountryChange = {
  from: MarketId;
  to: MarketId;
  subtotal: number | null;
  labels: Map<string, string>;
  contactCarriedOver: boolean;
};

function directCheckoutIssue(preview: DirectCheckoutPreview | undefined, destination: string) {
  switch (preview?.reason) {
    case "not-sold": return `This variant is unavailable in ${destination}.`;
    case "out-of-stock": return `This variant is out of stock in ${destination}.`;
    case "over-stock": return `Only ${preview.stock} available in ${destination}. Choose a smaller quantity.`;
    case "invalid-quantity": return "Choose a valid quantity on the product page.";
    default: return "This item is unavailable. Choose another product to continue.";
  }
}

export function RetailCheckout({ defaultDestination, directRequested, bangladesh, unitedStates, paypal }: {
  defaultDestination: MarketId;
  directRequested: boolean;
  bangladesh: BangladeshProps;
  unitedStates: Pick<PaypalProps, "directItem" | "directName" | "directPersonalization" | "personalizationIntent"> & DirectPreview;
  paypal: Omit<PaypalProps, "directItem" | "directName" | "directPersonalization" | "personalizationIntent" | "destinationControl" | "onCallbackCleared" | "contact">;
}) {
  const router = useRouter();
  const [destinationOverride, setDestinationOverride] = useState<MarketId>();
  const [switching, startSwitch] = useTransition();
  const [contact, setContact] = useState(() => checkoutContact(bangladesh.shopperAddress));
  const [contactFromSavedAddress, setContactFromSavedAddress] = useState(false);
  const [callback, setCallback] = useState(paypal.callback);
  const [countryChange, setCountryChange] = useState<CountryChange>();
  const [countrySwitchFailed, setCountrySwitchFailed] = useState(false);
  const renderedMarket = useRef(defaultDestination);
  const countrySelect = useRef<HTMLSelectElement>(null);
  const restoreCountryFocus = useRef<MarketId>(null);
  const pendingBangladesh = usePendingCheckout();
  const pendingPaypal = usePendingPaypal();
  const pricing = useCartPricing();
  const destination = destinationOverride ?? defaultDestination;
  const shippingMarket = bangladesh.prepaidAttempt ? "bd" : pendingPaypal || callback ? "us" : pendingBangladesh ? "bd" : destination;
  const market = markets[shippingMarket];
  const selection = shippingMarket === "bd" ? bangladesh : unitedStates;
  const preview = selection.directPreview;
  const recovering = Boolean(pendingBangladesh || pendingPaypal || callback || bangladesh.prepaidAttempt);
  const checkCart = bangladesh.demo && !directRequested && !recovering;
  const checkingCart = checkCart && (pricing.market.id !== shippingMarket || pricing.state === "loading");
  const cart = checkCart && pricing.market.id === shippingMarket ? pricing.cart : null;
  const missingItems = cart?.lines.filter(line => line.status !== "available") ?? [];
  const subtotal = directRequested
    ? preview?.unitMinor != null && !preview.reason ? preview.unitMinor * preview.quantity : null
    : cart?.subtotalMinor ?? null;
  const change = !recovering && countryChange?.to === shippingMarket ? countryChange : undefined;

  function clearSavedContact() {
    if (!contactFromSavedAddress) return;
    setContact(checkoutContact(bangladesh.shopperAddress));
    setContactFromSavedAddress(false);
  }

  useEffect(() => {
    if (!switching && !checkingCart && restoreCountryFocus.current === shippingMarket && countrySelect.current) {
      countrySelect.current.focus({ preventScroll: true });
      restoreCountryFocus.current = null;
    }
  }, [switching, checkingCart, shippingMarket]);

  useEffect(() => {
    if (!bangladesh.demo || renderedMarket.current === defaultDestination) return;
    renderedMarket.current = defaultDestination;
    // Refresh the shared storefront layout with the market selected by the checkout request.
    router.refresh();
  }, [bangladesh.demo, defaultDestination, router]);

  const country = (
    <>
    <label className="store-dialog__field">Shipping country
      <select ref={countrySelect} autoComplete="country" value={shippingMarket} onChange={event => {
        const next = event.target.value === "us" ? "us" : "bd";
        if (next === shippingMarket) return;
        setCountrySwitchFailed(false);
        restoreCountryFocus.current = next;
        const labels = new Map<string, string>(cart?.lines.flatMap(line => line.product
          ? [[line.variantId, `${line.product.name} · ${line.product.variantLabel}`]] : []));
        const nextChange: CountryChange = { from: shippingMarket, to: next, subtotal, labels,
          contactCarriedOver: !contactFromSavedAddress && Boolean(contact.name || contact.email || contact.phone) };
        const url = new URL(window.location.href);
        url.searchParams.set("destination", next);
        if (bangladesh.demo) {
          url.searchParams.delete("market");
          startSwitch(async () => {
            let saved = false;
            try {
              const response = await fetch(storefrontPath("/api/marketplace/region"), {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region: next }),
              });
              saved = response.ok;
            } catch {
              // The current address and quote remain usable if the preference cannot be saved.
            }
            if (saved) {
              startSwitch(() => {
                setCountryChange(nextChange);
                clearSavedContact();
                router.replace(`${localizedStorePath("/checkout", next)}${url.search}`, { scroll: false });
              });
            } else {
              restoreCountryFocus.current = shippingMarket;
              setCountrySwitchFailed(true);
            }
          });
          return;
        }
        window.history.replaceState(null, "", url);
        setCountryChange(nextChange);
        clearSavedContact();
        setDestinationOverride(next);
      }}>
        <option value="bd">Bangladesh</option>
        <option value="us">United States</option>
      </select>
    </label>
    {countrySwitchFailed && <p className="commerce-message" role="alert">Couldn’t change the shipping country. Try again.</p>}
    </>
  );

  const canQuote = shippingMarket === "us" ? paypal.quoteEnabled : Boolean(bangladesh.choices.length || bangladesh.manualChoices?.length);
  const canReview = canQuote && (directRequested ? Boolean(selection.directItem) : pricing.state !== "empty") && !missingItems.length;
  const notice = change && <section className="commerce-panel commerce-summary checkout-market-notice" aria-label="Updated checkout" aria-live="polite">
    <h2>Shipping to {market.name}</h2>
    {change.contactCarriedOver && <p>Your contact details carried over.</p>}
    {canReview && <p>Enter a delivery address and review the new total.</p>}
    {subtotal !== null && (!cart || cart.eligibleQuantity > 0) && <>
      <p>Merchandise subtotal{missingItems.length > 0 && " for eligible items"} before delivery and taxes.</p>
      <dl>
        {change.subtotal !== null && <div><dt>{markets[change.from].name}</dt><dd>{formatMoney(change.subtotal, markets[change.from])}</dd></div>}
        <div><dt>{market.name}</dt><dd>{formatMoney(subtotal, market)}</dd></div>
      </dl>
    </>}
  </section>;

  function showCheckout(content: ReactNode) {
    return <>
      {switching && <p className="state-panel" role="status">Updating checkout for the selected shipping country…</p>}
      <div inert={switching} aria-busy={switching}>
        {!checkingCart && notice}
        {content}
      </div>
    </>;
  }

  if (checkingCart) return showCheckout(<section className="commerce-panel commerce-form">
    {country}
    <p role="status">Checking current prices and availability for {market.name}…</p>
  </section>);
  if (missingItems.length) return showCheckout(
    <section className="commerce-panel commerce-form" aria-label="Items that need attention">
      {country}
      <h2>Review your cart for {market.name}</h2>
      <p>These items are still in your cart. Edit your cart or choose another shipping country to continue.</p>
      <ul className="purchased-items">{missingItems.map(line => <li key={cartItemKey(line)}>
        <div><strong>{line.product ? `${line.product.name} · ${line.product.variantLabel}`
          : change?.labels.get(line.variantId) ?? "Unavailable item"}</strong>
          <p>{cartLineIssue(line.product ? line.status : "not-sold", market.name)} · Quantity {line.quantity}</p>
        </div>
      </li>)}</ul>
      <Link className="button button--primary" href={`${localizedStorePath("/cart", shippingMarket)}?market=${shippingMarket}`}>Edit cart</Link>
    </section>
  );
  const pricingError = checkCart && pricing.state === "error" && <section className="commerce-panel checkout-market-notice" role="status">
    <p>We couldn’t check current cart prices here. Review your order for the latest total.</p>
  </section>;

  const contactBinding: CheckoutContactBinding = { value: contact, onChange: (value, source) => {
    setContact(value);
    if (source) setContactFromSavedAddress(source === "saved-address");
  } };
  if (shippingMarket === "us" && (unitedStates.directItem || !directRequested || pendingPaypal || callback)) {
    return showCheckout(<>{pricingError}<PaypalCheckout {...paypal} {...unitedStates} demo={bangladesh.demo} callback={callback}
      onCallbackCleared={() => setCallback(undefined)} destinationControl={country} contact={contactBinding} /></>);
  }
  if (shippingMarket === "bd" && (bangladesh.directItem || !directRequested || pendingBangladesh || bangladesh.prepaidAttempt)) {
    return showCheckout(<>{pricingError}<CheckoutView {...bangladesh} destinationControl={country} contact={contactBinding} /></>);
  }

  const otherMarket = shippingMarket === "us" ? "bd" : "us";
  const otherPreview = (otherMarket === "bd" ? bangladesh : unitedStates).directPreview;
  const productMarket = preview?.unitMinor != null ? shippingMarket : otherMarket;
  const back = preview?.slug && (preview.unitMinor != null || otherPreview?.unitMinor != null)
    ? `${localizedStorePath(`/products/${encodeURIComponent(preview.slug)}`, productMarket)}?market=${productMarket}&variant=${preview.variantId}`
    : undefined;
  return showCheckout(<section className="commerce-panel commerce-form">
    {country}
    {preview?.name && <h2>{preview.name}{preview.variantLabel ? ` · ${preview.variantLabel}` : ""}</h2>}
    <p>{directCheckoutIssue(preview, market.name)}</p>
    {back && <a className="button button--outline" href={back}>Back to product</a>}
    <Link className="text-link" href={localizedStorePath("/shop", shippingMarket)}>Continue shopping</Link>
  </section>);
}
