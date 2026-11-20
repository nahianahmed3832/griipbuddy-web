"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { formatMoney, type Market, type MarketId } from "@/config/markets";
import { storefrontBasePath, storefrontPath } from "@/config/storefront-path";
import { clearBuyPersonalization, rememberBuyPersonalization, useBuyPersonalization } from "@/lib/cart/buy-personalization";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { compareCartItems, type CartItem, type CheckoutCartItem } from "@/lib/cart/model";
import { personalizationAvailable, personalizationText, type Personalization } from "@/lib/catalog/personalization";
import type { paypalQuote } from "@/lib/commerce/paypal-checkout";
import { checkoutFailureCode, checkoutStep, measurementCheckoutHeaders, useCheckoutMeasurement, useCheckoutValidation,
  useForegroundObservation } from "@/lib/measurement/browser";
import type { CheckoutStep } from "@/lib/measurement/schema";
import { OrderBreakdown } from "./order-summary";
import { PersonalizationField } from "./personalization-field";
import { useCartPricing } from "./cart-pricing";

type Customer = {
  country: "US"; name: string; email: string; phone: string; addressLine1: string;
  addressLine2: string; city: string; state: string; postalCode: string;
};
type Checkout = { customer: Customer; items: CheckoutCartItem[] };
type Quoted = Extract<Awaited<ReturnType<typeof paypalQuote>>, { kind: "quoted" }>;
type Result =
  | Quoted
  | { kind: "approval_required"; approvalUrl: string; attemptId: string }
  | { kind: "placed"; orderId: string; purchased: CheckoutCartItem[] }
  | { kind: "pending" | "abandoned" | "invalid" | "unavailable" | "conflict" | "error"; message: string; issues?: string[] };
type Review = { checkout: Checkout; quote: Quoted["quote"] };
type Attempt = { id: string; direct?: CartItem & { personalizationIntent?: string } };
export type PaypalCallback = { action: "capture" | "cancel"; attemptId: string };

const pendingKey = `griipbuddy:paypal-checkout${storefrontBasePath}`;
const pendingListeners = new Set<() => void>();
const localPending = new Map<MarketId, string>();
const keyFor = (marketId: MarketId) => `${pendingKey}:${marketId}`;

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function readPending(marketId: MarketId) {
  try {
    return window.sessionStorage.getItem(keyFor(marketId)) ?? localPending.get(marketId) ??
      (marketId === "us" ? window.sessionStorage.getItem(pendingKey) : null);
  } catch { return localPending.get(marketId) ?? null; }
}

function rememberPaypal(marketId: MarketId, attempt: Attempt | null) {
  if (attempt) localPending.set(marketId, JSON.stringify(attempt));
  else localPending.delete(marketId);
  try {
    const saved = localPending.get(marketId);
    if (saved) window.sessionStorage.setItem(keyFor(marketId), saved);
    else window.sessionStorage.removeItem(keyFor(marketId));
    if (marketId === "us") window.sessionStorage.removeItem(pendingKey);
  } catch { /* Keep the in-memory recovery reference in this tab. */ }
  for (const listener of pendingListeners) listener();
}

export function usePendingPaypal(marketId: MarketId): Attempt | null {
  const raw = useSyncExternalStore(subscribePending, () => readPending(marketId), () => null);
  try { return raw ? JSON.parse(raw) as Attempt : null; }
  catch { return null; }
}

async function paypalRequest(marketId: MarketId, body: object): Promise<Result> {
  const response = await fetch(storefrontPath("/api/checkout/paypal"), {
    method: "POST", headers: { "Content-Type": "application/json", "x-griipbuddy-checkout-market": marketId, ...measurementCheckoutHeaders() }, body: JSON.stringify(body),
  });
  if (response.status >= 500) throw new Error("Checkout response unavailable");
  return response.json() as Promise<Result>;
}

const initialCustomer: Customer = {
  country: "US", name: "", email: "", phone: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "",
};

export function PaypalCheckout({ market, intakeOpen, quoteEnabled, paymentEnabled, callback, onCallbackCleared, destinationControl, shopperAddress, directItem, demo,
  directName, directProductId, directPersonalization, personalizationIntent }: {
  market: Market;
  intakeOpen: boolean; quoteEnabled: boolean; paymentEnabled: boolean; callback?: PaypalCallback; onCallbackCleared: () => void; destinationControl: ReactNode;
  shopperAddress?: Pick<Customer, "name" | "email">;
  demo?: boolean;
  directItem?: CartItem; directName?: string; directProductId?: string; directPersonalization?: Personalization; personalizationIntent?: string;
}) {
  const router = useRouter();
  const marketId = market.id;
  const { ready: cartReady, items: cartItems, sync, message: syncMessage } = useCart();
  const { completePurchase, retrySync } = useCartActions();
  const priced = useCartPricing();
  const pending = usePendingPaypal(marketId);
  const ready = cartReady || Boolean(directItem || pending || callback);
  const [customer, setCustomer] = useState({ ...initialCustomer, ...shopperAddress });
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
  const items = directItem ? [{ ...directItem, ...(personalization && { personalization }) }] : priced.cart?.checkoutItems ?? [];
  const cartChanged = Boolean(review && JSON.stringify([...items].sort(compareCartItems)) !==
    JSON.stringify([...review.checkout.items].sort(compareCartItems)));
  const activeAttempt = callback?.attemptId ?? pending?.id;
  const cartEligible = Boolean(directItem || priced.cart && priced.cart.affectedLines === 0);
  const singleLine = items.length === 1 && (directItem || cartItems.length === 1) ? items[0] : undefined;
  const checkoutContext = singleLine ? { variantId: singleLine.variantId, offerId: singleLine.offerId,
    productId: directItem ? directProductId : priced.cart?.lines.find(line => line.status === "available")?.product?.productId,
  } : undefined;
  const reportStep = (step: CheckoutStep, code?: Parameters<typeof checkoutStep>[2]) => checkoutStep(marketId, step, code, checkoutContext);
  useCheckoutMeasurement(ready && cartEligible && quoteEnabled && items.length > 0 && !activeAttempt, marketId, singleLine?.variantId, checkoutContext);
  useForegroundObservation(`${marketId}-unavailable`, ready && cartEligible && !quoteEnabled && items.length > 0 && !activeAttempt,
    () => reportStep("ADDRESS", "UNAVAILABLE"));
  const reportInvalidAddress = useCheckoutValidation(marketId, checkoutContext);

  function updateCustomer(key: Exclude<keyof Customer, "country">, value: string) {
    setReview(null);
    setMessage(null);
    setCustomer(previous => ({ ...previous, [key]: value }));
  }

  async function run(step: CheckoutStep, task: () => Promise<void>, failure: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try { await task(); }
    catch {
      reportStep(step, "NETWORK");
      setMessage({ text: failure, error: true });
    }
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
    if (inFlight.current) return;
    reportStep("RECOVERY");
    await run("RECOVERY", async () => {
      const result = await paypalRequest(marketId, { action, attemptId });
      const match = pending?.id === attemptId ? pending : null;
      if (result.kind === "placed") {
        if (match && !match.direct || !match && result.purchased.some(line => line.cartOfferId || line.cartVariantId)) {
          await completePurchase(result.orderId, result.purchased);
        }
        if (match?.direct) clearBuyPersonalization(match.direct.personalizationIntent, match.direct.variantId);
        if (match) rememberPaypal(marketId, null);
        router.replace(`/orders/${result.orderId}`);
        return;
      }
      if (result.kind === "approval_required") {
        setResumeUrl(result.approvalUrl);
        if (action === "capture") setMessage({ text: "PayPal approval is still required.", error: false });
        return;
      }
      if ("message" in result) {
        if (result.kind !== "pending") reportStep("RECOVERY", checkoutFailureCode(result.kind));
        showResult(result);
      }
      if (result.kind === "abandoned") {
        if (match) rememberPaypal(marketId, null);
        setResumeUrl(undefined);
        setReview(null);
        clearCallback();
        if (callback && match?.direct) {
          const { variantId, offerId, quantity, personalizationIntent: savedIntent } = match.direct;
          const params = new URLSearchParams({ market: marketId, buy: variantId, quantity: String(quantity) });
          if (offerId) params.set("offer", offerId);
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
    if (!items.length || !personalizationValid || inFlight.current) return;
    reportStep("ADDRESS");
    reportStep("DELIVERY_PAYMENT");
    const checkout: Checkout = { customer: { ...customer, state: customer.state.toUpperCase() }, items: [...items] };
    void run("REVIEW", async () => {
      const result = await paypalRequest(marketId, { action: "quote", checkout });
      if (result.kind === "quoted") {
        reportStep("REVIEW");
        setReview({ checkout, quote: result.quote });
        requestAnimationFrame(() => reviewSummary.current?.focus());
      } else if ("message" in result) {
        reportStep("REVIEW", checkoutFailureCode(result.kind));
        showResult(result);
      }
    }, "Couldn’t review this order. Your cart is still saved.");
  }

  function startPayment() {
    if (!review || cartChanged || inFlight.current || !paymentEnabled || pending) return;
    reportStep("SUBMIT");
    const attemptId = crypto.randomUUID();
    const savedIntent = directItem && personalization ? rememberBuyPersonalization(directItem.variantId, personalization) : undefined;
    rememberPaypal(marketId, { id: attemptId, direct: directItem ? { ...directItem, personalizationIntent: savedIntent } : undefined });
    void run("SUBMIT", async () => {
      const result = await paypalRequest(marketId, { action: "create", checkout: review.checkout, quoteToken: review.quote.quoteToken, attemptId });
      if (result.kind === "approval_required") {
        reportStep("PROVIDER_REDIRECT");
        window.location.assign(result.approvalUrl);
        return;
      }
      if ("message" in result) {
        if (result.kind !== "pending") reportStep("SUBMIT", checkoutFailureCode(result.kind));
        showResult(result);
      }
      if (result.kind === "invalid" || result.kind === "conflict" || result.kind === "unavailable" || result.kind === "abandoned") {
        rememberPaypal(marketId, null);
        setReview(null);
      }
    }, "Couldn’t confirm whether PayPal started. Check this attempt before trying again.");
  }

  const status = message && <div className={message.error ? "commerce-message commerce-message--error" : "commerce-message"} role={message.error ? "alert" : "status"}>
    <p>{message.text}</p>
    {message.issues?.length ? <ul>{message.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}
  </div>;
  if (!ready) return <div className="state-panel" role="status">{sync === "error" ? <>
    <p>{syncMessage}</p><button type="button" className="button button--outline" onClick={retrySync}>Retry cart sync</button>
  </> : "Loading your cart…"}</div>;

  if (activeAttempt) return <section className="commerce-panel commerce-form">
    <h2>{busy ? "Checking PayPal payment…" : "Your PayPal payment"}</h2>
    {status}
    {!busy && <div className="commerce-stack">
      {resumeUrl && <a className="button button--primary" href={resumeUrl} onClick={() => reportStep("PROVIDER_REDIRECT")}>Continue to PayPal</a>}
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
    <Link className="button button--outline" href="/cart">Back to cart</Link>
  </div>;

  if (!directItem && cartItems.length && priced.state === "loading") {
    return <>{destinationControl}<div className="state-panel" role="status">Checking your cart in {market.name}…</div></>;
  }
  if (!directItem && cartItems.length && (priced.state === "error" || priced.cart?.affectedLines)) {
    return <>{destinationControl}<div className="state-panel">
      <p>{priced.state === "error" ? "We couldn’t check this cart. Your items are still saved."
        : `Review the unavailable items in your cart before ordering in ${market.name}.`}</p>
      {priced.state === "error" && <button className="button button--outline" type="button" onClick={priced.retry}>Try again</button>}
      <Link href="/cart" className="button button--primary">Back to cart</Link>
    </div></>;
  }

  if (!items.length) return <div className="commerce-panel commerce-form">
    {destinationControl}
    <p>Your cart is empty.</p>
    <Link className="button button--outline" href="/shop">Browse products</Link>
  </div>;

  const quote = cartChanged ? null : review?.quote;
  return <form className="commerce-layout checkout-linear" onInvalid={reportInvalidAddress} onSubmit={event => {
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
        {demo && <p className="commerce-muted">Use sample contact and address details for this test order.</p>}
        {destinationControl}
        <label>Full name<input required autoComplete="name" minLength={2} maxLength={100} value={customer.name} onChange={event => updateCustomer("name", event.target.value)} /></label>
        <div className="commerce-fields">
          <label>Phone number<input required type="tel" autoComplete="tel" maxLength={28} value={customer.phone} onChange={event => updateCustomer("phone", event.target.value)} /></label>
          <label>Email (optional)<input type="email" autoComplete="email" maxLength={254} value={customer.email} onChange={event => updateCustomer("email", event.target.value)} /></label>
        </div>
        <label>Street address<input required autoComplete="address-line1" minLength={5} maxLength={120} value={customer.addressLine1} onChange={event => updateCustomer("addressLine1", event.target.value)} /></label>
        <label>Apartment, suite, etc. (optional)<input autoComplete="address-line2" maxLength={120} value={customer.addressLine2} onChange={event => updateCustomer("addressLine2", event.target.value)} /></label>
        <div className="commerce-fields">
          <label>City<input required autoComplete="address-level2" minLength={2} maxLength={100} value={customer.city} onChange={event => updateCustomer("city", event.target.value)} /></label>
          <label>State code<input required autoComplete="address-level1" pattern="[A-Za-z]{2}" placeholder="NY" maxLength={2} value={customer.state} onChange={event => updateCustomer("state", event.target.value)} /></label>
        </div>
        <label>ZIP code<input required autoComplete="postal-code" inputMode="numeric" pattern="[0-9]{5}(?:-[0-9]{4})?" maxLength={10} value={customer.postalCode} onChange={event => updateCustomer("postalCode", event.target.value)} /></label>
      </fieldset>
      <section className="commerce-panel">
        <h2><span className="checkout-section-number" aria-hidden="true">2</span> Delivery and payment</h2>
        <p>PayPal in USD · Test orders only</p>
        {quote && <p>{quote.deliveryLabel}</p>}
      </section>
    </div>
    <aside className="commerce-stack checkout-linear-summary" ref={reviewSummary} tabIndex={-1} aria-label="Review and place order">
      {status}
      {quote ? <>
        <OrderBreakdown market={market} heading="Review your order" totals={{
          subtotalMinor: quote.merchandiseSubtotalMinor, discountMinor: 0,
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
            <strong>{formatMoney(line.lineMinor, market)}</strong>
          </li>)}</ul>
        </details>
      </> : <section className="commerce-panel"><h2>Order summary</h2>
        <p>{items.reduce((count, item) => count + item.quantity, 0)} items in this order</p>
        <p className="commerce-muted">Enter your address to confirm the total.</p>
      </section>}
      {quote && !paymentEnabled ? <p className="commerce-message">PayPal sandbox credentials are required to test payment.</p> :
        <button className="button button--primary" type="submit" disabled={busy || !personalizationValid}>
          {busy ? "Checking order…" : quote ? "Continue to PayPal" : "Review order"} <ArrowRight size={17} aria-hidden="true" />
        </button>}
    </aside>
  </form>;
}
