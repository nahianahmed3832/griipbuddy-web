"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { formatMoney, markets } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontBasePath, storefrontPath } from "@/config/storefront-path";
import { clearBuyPersonalization, rememberBuyPersonalization, useBuyPersonalization } from "@/lib/cart/buy-personalization";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { compareCartItems, type CartItem } from "@/lib/cart/model";
import { personalizationAvailable, personalizationText, type Personalization } from "@/lib/catalog/personalization";
import type { paypalQuote } from "@/lib/commerce/paypal-checkout";
import { OrderBreakdown } from "./order-summary";
import { PersonalizationField } from "./personalization-field";
import { checkoutContact, type CheckoutContactBinding } from "@/lib/commerce/checkout-contact";
import { usPreviewDeliveryArea, usPreviewStates, usSampleRecipient } from "@/lib/commerce/us-delivery";
import type { UsAddress } from "@/lib/marketplace/address-command";
import { SaveCheckoutAddress } from "./marketplace/address-book";

type Customer = UsAddress;
type Checkout = { customer: Customer; items: CartItem[] };
type Quoted = Extract<Awaited<ReturnType<typeof paypalQuote>>, { kind: "quoted" }>;
type Result =
  | Quoted
  | { kind: "approval_required"; approvalUrl: string; attemptId: string }
  | { kind: "placed"; orderId: string; purchased: CartItem[] }
  | { kind: "pending" | "abandoned" | "invalid" | "unavailable" | "conflict" | "error"; message: string; issues?: string[] };
type Review = { checkout: Checkout; quote: Quoted["quote"] };
type Attempt = { id: string; direct?: CartItem & { personalizationIntent?: string } };
export type PaypalCallback = { action: "capture" | "cancel"; attemptId: string };

const pendingKey = `griipbuddy:paypal-checkout${storefrontBasePath}`;
const pendingListeners = new Set<() => void>();
let localPending: string | null = null;

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function readPending() {
  try { return window.sessionStorage.getItem(pendingKey) ?? localPending; }
  catch { return localPending; }
}

function rememberPaypal(attempt: Attempt | null) {
  localPending = attempt ? JSON.stringify(attempt) : null;
  try {
    if (localPending) window.sessionStorage.setItem(pendingKey, localPending);
    else window.sessionStorage.removeItem(pendingKey);
  } catch { /* Keep the in-memory recovery reference in this tab. */ }
  for (const listener of pendingListeners) listener();
}

export function usePendingPaypal(): Attempt | null {
  const raw = useSyncExternalStore(subscribePending, readPending, () => null);
  try { return raw ? JSON.parse(raw) as Attempt : null; }
  catch { return null; }
}

async function paypalRequest(body: object): Promise<Result> {
  const response = await fetch(storefrontPath("/api/checkout/paypal"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return response.json() as Promise<Result>;
}

const initialCustomer: Customer = {
  country: "US", name: "", email: "", phone: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "",
};

export function PaypalCheckout({ intakeOpen, quoteEnabled, paymentEnabled, shippingMinor, callback, onCallbackCleared, destinationControl, shopperAddress, directItem, demo,
  directName, directPersonalization, personalizationIntent, contact, addresses = [], canSaveAddress = false }: {
  intakeOpen: boolean; quoteEnabled: boolean; paymentEnabled: boolean; shippingMinor: number | null;
  callback?: PaypalCallback; onCallbackCleared: () => void; destinationControl: ReactNode;
  shopperAddress?: Pick<Customer, "name" | "email">;
  demo?: boolean;
  contact?: CheckoutContactBinding;
  directItem?: CartItem; directName?: string; directPersonalization?: Personalization; personalizationIntent?: string;
  addresses?: readonly { id: string; label: string; value: UsAddress; isDefault: boolean }[];
  canSaveAddress?: boolean;
}) {
  const router = useRouter();
  const { ready, items: cartItems } = useCart();
  const { completePurchase } = useCartActions();
  const pending = usePendingPaypal();
  const [customerDraft, setCustomerDraft] = useState({ ...initialCustomer, ...shopperAddress });
  const customer = { ...customerDraft, ...contact?.value };
  const [review, setReview] = useState<Review | null>(null);
  const [message, setMessage] = useState<{ text: string; issues?: string[]; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [resumeUrl, setResumeUrl] = useState<string>();
  const inFlight = useRef(false);
  const handledCallback = useRef<string>(null);
  const reviewSummary = useRef<HTMLElement>(null);
  const carriedText = useBuyPersonalization(personalizationIntent, directItem?.variantId);
  const [personalizationDraft, setPersonalizationDraft] = useState<string | null>(null);
  const directText = directPersonalization ? (personalizationDraft ?? carriedText) : "";
  const personalization = personalizationText(directText);
  const personalizationValid = (!directText.trim() || Boolean(personalization)) &&
    personalizationAvailable(directPersonalization, personalization);
  const items = directItem ? [{ ...directItem, ...(personalization && { personalization }) }] : cartItems;
  const cartChanged = Boolean(review && JSON.stringify([...items].sort(compareCartItems)) !==
    JSON.stringify([...review.checkout.items].sort(compareCartItems)));

  function updateCustomer(key: Exclude<keyof Customer, "country">, value: string) {
    setReview(null);
    setMessage(null);
    if (contact && (key === "name" || key === "email" || key === "phone")) {
      contact.onChange({ ...contact.value, [key]: value });
    } else {
      setCustomerDraft(previous => ({ ...previous, [key]: value }));
    }
  }

  function fillSampleAddress() {
    const { name, phone } = usSampleRecipient;
    setCustomerDraft(previous => ({ ...previous, ...usSampleRecipient, addressLine2: "" }));
    contact?.onChange({ ...contact.value, name, phone });
    setReview(null);
    setMessage(null);
  }

  async function run(task: () => Promise<void>, failure: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try { await task(); }
    catch { setMessage({ text: failure, error: true }); }
    finally { inFlight.current = false; setBusy(false); }
  }

  function clearCallback() {
    if (!callback) return;
    const url = new URL(window.location.href);
    for (const key of ["paypal", "attempt", "token", "PayerID"]) url.searchParams.delete(key);
    window.history.replaceState(null, "", url);
    onCallbackCleared();
  }

  function showResult(result: Extract<Result, { message: string }>) {
    setMessage({ text: result.message, issues: result.issues, error: result.kind !== "abandoned" && result.kind !== "pending" });
  }

  async function processAttempt(action: "capture" | "recover" | "cancel", attemptId: string) {
    await run(async () => {
      const result = await paypalRequest({ action, attemptId });
      const match = pending?.id === attemptId ? pending : null;
      if (result.kind === "placed") {
        if (match && !match.direct) await completePurchase(result.orderId, result.purchased);
        if (match?.direct) clearBuyPersonalization(match.direct.personalizationIntent, match.direct.variantId);
        if (match) rememberPaypal(null);
        router.replace(marketStoreHref(`/orders/${result.orderId}`, demo ? "us" : undefined));
        return;
      }
      if (result.kind === "approval_required") {
        setResumeUrl(result.approvalUrl);
        if (action === "capture") setMessage({ text: "PayPal approval is still required.", error: false });
        return;
      }
      if ("message" in result) showResult(result);
      if (result.kind === "abandoned") {
        if (match) rememberPaypal(null);
        setResumeUrl(undefined);
        setReview(null);
        clearCallback();
        if (callback && match?.direct) {
          const { variantId, quantity, personalizationIntent: savedIntent } = match.direct;
          const params = new URLSearchParams({ destination: "us", buy: variantId, quantity: String(quantity) });
          if (savedIntent) params.set("custom", savedIntent);
          router.replace(`/checkout?${params}`);
        }
      }
    }, "We couldn’t verify your PayPal payment. Check this attempt before starting a new one.");
  }

  const processCallback = useEffectEvent((result: PaypalCallback) => {
    if (handledCallback.current === result.attemptId) return;
    handledCallback.current = result.attemptId;
    void processAttempt(result.action, result.attemptId);
  });
  useEffect(() => {
    if (callback && ready) void Promise.resolve().then(() => processCallback(callback));
  }, [callback, ready]);

  function reviewOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!items.length || !personalizationValid) return;
    const checkout: Checkout = { customer: { ...customer, state: customer.state.toUpperCase() }, items: [...items] };
    void run(async () => {
      const result = await paypalRequest({ action: "quote", checkout });
      if (result.kind === "quoted") {
        setReview({ checkout, quote: result.quote });
        requestAnimationFrame(() => reviewSummary.current?.focus());
      } else if ("message" in result) showResult(result);
    }, "Couldn’t review this order. Your cart is still saved.");
  }

  function startPayment() {
    if (!review || cartChanged || inFlight.current || !paymentEnabled || pending) return;
    const attemptId = crypto.randomUUID();
    const savedIntent = directItem && personalization ? rememberBuyPersonalization(directItem.variantId, personalization) : undefined;
    rememberPaypal({ id: attemptId, direct: directItem ? { ...directItem, personalizationIntent: savedIntent } : undefined });
    void run(async () => {
      const result = await paypalRequest({ action: "create", checkout: review.checkout, quoteToken: review.quote.quoteToken, attemptId });
      if (result.kind === "approval_required") {
        window.location.assign(result.approvalUrl);
        return;
      }
      if ("message" in result) showResult(result);
      if (result.kind === "invalid" || result.kind === "conflict" || result.kind === "unavailable" || result.kind === "abandoned") {
        rememberPaypal(null);
        setReview(null);
      }
    }, "Couldn’t confirm whether PayPal started. Check this attempt before trying again.");
  }

  const status = message && <div className={message.error ? "commerce-message commerce-message--error" : "commerce-message"} role={message.error ? "alert" : "status"}>
    <p>{message.text}</p>
    {message.issues?.length ? <ul>{message.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}
  </div>;
  const activeAttempt = callback?.attemptId ?? pending?.id;

  if (!ready) return <p className="state-panel" role="status">Loading your cart…</p>;

  if (activeAttempt) return <section className="commerce-panel commerce-form">
    <h2>{busy ? "Checking PayPal payment…" : "Your PayPal payment"}</h2>
    {status}
    {!busy && <div className="commerce-stack">
      {resumeUrl && <a className="button button--primary" href={resumeUrl}>Continue to PayPal</a>}
      <button type="button" className="button button--outline" onClick={() => void processAttempt(callback?.action ?? "recover", activeAttempt)}>
        Check payment status
      </button>
      {callback?.action !== "cancel" && <button type="button" className="link-button" onClick={() => void processAttempt("cancel", activeAttempt)}>
        Cancel payment attempt
      </button>}
    </div>}
  </section>;

  if (!quoteEnabled) return <div className="commerce-panel commerce-form">
    {destinationControl}
    <p>{intakeOpen ? "United States delivery is unavailable in this preview." : "Checkout is paused. Your cart is still saved."}</p>
    <Link className="button button--outline" href={marketStoreHref("/cart", demo ? "us" : undefined)}>Back to cart</Link>
  </div>;

  if (!items.length) return <div className="commerce-panel commerce-form">
    {destinationControl}
    <p>Your cart is empty.</p>
    <Link className="button button--outline" href={marketStoreHref("/shop", demo ? "us" : undefined)}>Browse products</Link>
  </div>;

  const quote = cartChanged ? null : review?.quote;
  const deliveryQuote = quote?.shippingMinor ?? shippingMinor;
  return <form className="commerce-layout checkout-linear" onSubmit={event => {
    if (!quote) reviewOrder(event);
    else {
      event.preventDefault();
      startPayment();
    }
  }}>
    <div className="commerce-stack">
      {directName && <p className="commerce-panel"><strong>Buy it now</strong> · {directName} × {directItem?.quantity}</p>}
      {directPersonalization && <fieldset className="commerce-panel commerce-form" disabled={busy}>
        <legend className="sr-only">Personalization</legend>
        <PersonalizationField settings={directPersonalization} value={directText} onChange={setPersonalizationDraft} />
      </fieldset>}
      <fieldset className="commerce-panel commerce-form" disabled={busy}>
        <legend className="sr-only">Contact and delivery address</legend>
        <h2><span className="checkout-section-number" aria-hidden="true">1</span> Delivery address</h2>
        {demo && <p className="commerce-muted">Use sample details for this test order. <button type="button" className="link-button" onClick={fillSampleAddress}>Fill sample address</button></p>}
        {destinationControl}
        {addresses.length > 0 && <label>Saved addresses<select defaultValue="" onChange={event => {
          const selected = addresses.find(address => address.id === event.target.value)?.value ?? { ...initialCustomer, ...shopperAddress };
          setCustomerDraft(selected);
          contact?.onChange(checkoutContact(selected), event.target.value ? "saved-address" : "new-address");
          setReview(null);
          setMessage(null);
        }}><option value="">Enter a new address</option>{addresses.map(address => <option key={address.id} value={address.id}>
          {address.label}{address.isDefault && " (default)"}</option>)}</select></label>}
        <label>Full name<input required autoComplete="name" minLength={2} maxLength={100} value={customer.name} onChange={event => updateCustomer("name", event.target.value)} /></label>
        <div className="commerce-fields">
          <label>Phone number<input required type="tel" autoComplete="tel" maxLength={28} value={customer.phone} onChange={event => updateCustomer("phone", event.target.value)} /></label>
          <label>Email (optional)<input type="email" autoComplete="email" maxLength={254} value={customer.email} onChange={event => updateCustomer("email", event.target.value)} /></label>
        </div>
        <label>Street address<input required autoComplete="address-line1" minLength={5} maxLength={120} value={customer.addressLine1} onChange={event => updateCustomer("addressLine1", event.target.value)} /></label>
        <label>Apartment, suite, etc. (optional)<input autoComplete="address-line2" maxLength={120} value={customer.addressLine2} onChange={event => updateCustomer("addressLine2", event.target.value)} /></label>
        <div className="commerce-fields">
          <label>City<input required autoComplete="address-level2" minLength={2} maxLength={100} value={customer.city} onChange={event => updateCustomer("city", event.target.value)} /></label>
          <label>State
            <select required autoComplete="address-level1" value={customer.state} onChange={event => updateCustomer("state", event.target.value)}>
              <option value="">Select a state</option>
              {usPreviewStates.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </label>
        </div>
        <label>ZIP code<input required autoComplete="postal-code" inputMode="numeric" pattern="[0-9]{5}(?:-[0-9]{4})?" maxLength={10} value={customer.postalCode} onChange={event => updateCustomer("postalCode", event.target.value)} /></label>
        {canSaveAddress && <SaveCheckoutAddress marketId="us" language="en" details={customer} />}
      </fieldset>
      <section className="commerce-panel">
        <h2><span className="checkout-section-number" aria-hidden="true">2</span> Delivery and payment</h2>
        <p>Test shipping covers {usPreviewDeliveryArea}.</p>
        {deliveryQuote !== null && <p>Standard test shipping · {formatMoney(deliveryQuote, markets.us)}</p>}
        {paymentEnabled && <p>PayPal sandbox in USD. Use a sandbox account.</p>}
      </section>
    </div>
    <aside className="commerce-stack checkout-linear-summary" ref={reviewSummary} tabIndex={-1} aria-label="Review and place order">
      {status}
      {quote ? <>
        <OrderBreakdown market={markets.us} heading="Review your order" totals={{
          subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor,
          deliveryMinor: quote.shippingMinor, taxMinor: quote.taxMinor, taxLabel: "Test tax", totalMinor: quote.totalMinor,
        }} />
        <details className="commerce-panel checkout-extras">
          <summary>View order items</summary>
          <ul className="purchased-items">{quote.lines.map((line, index) => <li key={`${line.name}-${index}`}>
            <div>
              <strong>{line.name}</strong>
              <p>{line.variantLabel} · Quantity {line.quantity}</p>
              {line.personalization && <p className="personalization-note">Personalization: {line.personalization}</p>}
            </div>
            <strong>{formatMoney(line.lineMinor, markets.us)}</strong>
          </li>)}</ul>
        </details>
      </> : <section className="commerce-panel"><h2>Order summary</h2>
        <p>{items.reduce((count, item) => count + item.quantity, 0)} items in this order</p>
        <p className="commerce-muted">Enter your address to confirm the total.</p>
      </section>}
      {!paymentEnabled && <p className="commerce-message">PayPal sandbox payment is currently unavailable.{!quote && " You can still review the USD total."}</p>}
      {(!quote || paymentEnabled) &&
        <button className="button button--primary" type="submit" disabled={busy || !personalizationValid}>
          {busy ? "Checking order…" : quote ? "Continue to PayPal" : "Review order"} <ArrowRight size={17} aria-hidden="true" />
        </button>}
    </aside>
  </form>;
}
