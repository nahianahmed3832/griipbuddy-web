"use client";

import { ArrowRight, CreditCard, Truck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { localizedStorePath } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { rememberPending, usePendingCheckout } from "@/lib/cart/checkout-attempt";
import { checkoutFailureCode, checkoutStep, measurementCheckoutHeaders, useCheckoutMeasurement, useCheckoutValidation,
  useForegroundObservation } from "@/lib/measurement/browser";
import type { CheckoutStep } from "@/lib/measurement/schema";
import type {
  CheckoutDetails, CheckoutQuote, DeliveryChoice, OrderPlaced, PrepaidCheckoutDetails, PrepaidPaymentResult,
  RecoverResult, ReviewResult, SubmitResult,
} from "@/lib/commerce/checkout-types";
import { compareCartItems, type CartItem } from "@/lib/cart/model";
import { clearBuyPersonalization, useBuyPersonalization } from "@/lib/cart/buy-personalization";
import { personalizationAvailable, personalizationText, type Personalization } from "@/lib/catalog/personalization";
import { OrderBreakdown, PurchasedItems } from "./order-summary";
import { PersonalizationField } from "./personalization-field";
import { useCartPricing } from "./cart-pricing";
import "./checkout-view.css";

type Address = CheckoutDetails["customer"];
type NativeCheckoutInput = CheckoutDetails | PrepaidCheckoutDetails;
type Review = { input: NativeCheckoutInput; quote: CheckoutQuote; attemptId: string };
type Notice = { message: string; issues?: string[]; error?: boolean };
const initialAddress: Address = { name: "", phone: "", email: "", district: "", locality: "", address: "", postalCode: "" };

async function checkoutRequest<T>(marketId: Market["id"], body: object, prepaid = false): Promise<T> {
  const response = await fetch(storefrontPath(prepaid ? "/api/checkout/prepaid" : "/api/checkout"), {
    method: "POST", headers: { "Content-Type": "application/json", "x-griipbuddy-checkout-market": marketId, ...measurementCheckoutHeaders() }, body: JSON.stringify(body),
  });
  if (response.status >= 500) throw new Error("Checkout response unavailable");
  return response.json() as Promise<T>;
}

export type CheckoutAddress = { id: string; label: string; value: Address };

export function CheckoutView({ market, addressAdapter, choices, prepaidChoices = [], directItem, directName, directProductId, directPersonalization, personalizationIntent,
  marketplace = false, addresses = [], shopperAddress, destinationControl, prepaidAttempt, demo = false }: {
  market: Market;
  addressAdapter: "bd-district" | "us-postal";
  choices: readonly DeliveryChoice[];
  prepaidChoices?: readonly DeliveryChoice[];
  directItem?: CartItem; directName?: string; directProductId?: string; marketplace?: boolean;
  directPersonalization?: Personalization; personalizationIntent?: string;
  addresses?: readonly CheckoutAddress[]; shopperAddress?: Partial<Address>;
  destinationControl?: ReactNode;
  prepaidAttempt?: string;
  demo?: boolean;
}) {
  const router = useRouter();
  const marketId = market.id;
  const postalAddress = addressAdapter === "us-postal";
  const districtLabel = postalAddress ? "State" : "District";
  const { ready: cartReady, items: cartItems, sync, message: syncMessage } = useCart();
  const { completePurchase, retrySync } = useCartActions();
  const priced = useCartPricing();
  const carriedText = useBuyPersonalization(personalizationIntent, directItem?.variantId);
  const [personalizationDraft, setPersonalizationDraft] = useState<string | null>(null);
  const directText = directPersonalization ? (personalizationDraft ?? carriedText) : "";
  const personalization = personalizationText(directText);
  const validPersonalization = (!directText.trim() || Boolean(personalization)) &&
    personalizationAvailable(directPersonalization, personalization);
  const items = directItem ? [{ ...directItem, ...(personalization && { personalization }) }] : priced.cart?.checkoutItems ?? [];
  const pendingAttempt = usePendingCheckout(marketId);
  const ready = cartReady || Boolean(directItem || pendingAttempt || prepaidAttempt);
  const [callback, setCallback] = useState(prepaidAttempt);
  const [address, setAddress] = useState({ ...initialAddress, ...shopperAddress });
  const [gift, setGift] = useState(false);
  const [giftNote, setGiftNote] = useState("");
  const [coupon, setCoupon] = useState("");
  const [method, setMethod] = useState("");
  const [payment, setPayment] = useState<NativeCheckoutInput["paymentMethod"]>(choices.length || !prepaidChoices.length ? "COD" : "SSLCOMMERZ");
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const verifiedCallback = useRef<string>(null);
  const summary = useRef<HTMLElement>(null);
  const activeChoices = payment === "COD" ? choices : prepaidChoices;
  const districts = [...new Map(activeChoices.map(choice => [choice.district, choice.districtLabel])).entries()];
  const methods = activeChoices.filter(({ district }) => district === address.district);
  const selectedMethod = methods.find(choice => choice.method === method) ?? methods[0];
  const locked = Boolean(pendingAttempt || callback);
  const cartChanged = Boolean(review && JSON.stringify([...items].sort(compareCartItems)) !==
    JSON.stringify([...review.input.items].sort(compareCartItems)));
  const confirmed = review && !cartChanged ? review : null;
  const cartEligible = Boolean(directItem || priced.cart && priced.cart.affectedLines === 0);
  const singleLine = items.length === 1 && (directItem || cartItems.length === 1) ? items[0] : undefined;
  const checkoutContext = singleLine ? { variantId: singleLine.variantId, offerId: singleLine.offerId,
    productId: directItem ? directProductId : priced.cart?.lines.find(line => line.status === "available")?.product?.productId,
  } : undefined;
  const reportStep = (step: CheckoutStep, code?: Parameters<typeof checkoutStep>[2]) => checkoutStep(marketId, step, code, checkoutContext);
  useCheckoutMeasurement(ready && cartEligible && activeChoices.length > 0 && items.length > 0 && !locked, marketId, singleLine?.variantId, checkoutContext);
  useForegroundObservation(`${marketId}-unavailable`, ready && cartEligible && items.length > 0 && !locked && !choices.length && !prepaidChoices.length,
    () => reportStep("ADDRESS", "UNAVAILABLE"));
  const reportInvalidAddress = useCheckoutValidation(marketId, checkoutContext);

  function invalidateQuote() {
    setReview(null);
    setNotice(null);
  }

  function updateAddress(key: keyof Address, value: string) {
    invalidateQuote();
    setAddress(previous => ({ ...previous, [key]: value }));
    if (key === "district") setMethod("");
  }

  async function run(step: CheckoutStep, task: () => Promise<void>, failedMessage: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await task();
    } catch {
      reportStep(step, "NETWORK");
      setNotice({ message: failedMessage, error: true });
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function finish(order: OrderPlaced, direct: boolean) {
    if (!direct) await completePurchase(order.orderId, order.purchased);
    if (direct) clearBuyPersonalization(personalizationIntent, directItem?.variantId);
    rememberPending(marketId, null);
    const path = `/orders/${order.orderId}`;
    router.replace(demo ? localizedStorePath(path, marketId) : path);
  }

  function clearCallback() {
    if (!callback) return;
    setCallback(undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete("prepaid");
    window.history.replaceState(null, "", url);
  }

  async function recoverOrder(attemptId: string, prepaid: boolean, resume = false) {
    if (inFlight.current) return;
    reportStep("RECOVERY");
    await run("RECOVERY", async () => {
      const result = await checkoutRequest<RecoverResult | PrepaidPaymentResult>(marketId, { action: "recover", attemptId, ...(prepaid && { resume }) }, prepaid);
      if (result.kind === "placed") {
        await finish(result, "direct" in result ? result.direct : Boolean(pendingAttempt?.direct));
        return;
      }
      if (result.kind === "continue") {
        reportStep("PROVIDER_REDIRECT");
        window.location.assign(result.redirectUrl);
        return;
      }
      if (result.kind !== "pending") reportStep("RECOVERY", checkoutFailureCode(result.kind));
      if ("message" in result) {
        setNotice({ ...result, error: result.kind !== "pending" && result.kind !== "abandoned" });
      }
      if (result.kind === "abandoned") {
        rememberPending(marketId, null);
        setReview(null);
        clearCallback();
      }
    }, "We couldn’t verify your last payment. Check its status before paying again.");
  }

  const handleReturn = useEffectEvent((attemptId: string) => {
    if (verifiedCallback.current === attemptId) return;
    verifiedCallback.current = attemptId;
    void recoverOrder(attemptId, true);
  });
  useEffect(() => {
    if (callback && ready) void Promise.resolve().then(() => handleReturn(callback));
  }, [callback, ready]);

  function reviewOrder() {
    if (!selectedMethod || locked || !validPersonalization || inFlight.current) return;
    reportStep("ADDRESS");
    reportStep("DELIVERY_PAYMENT");
    const input: NativeCheckoutInput = { marketId, items: [...items],
      customer: market.countryCode === "US"
        ? { ...address, country: market.countryCode, postalCode: address.postalCode ?? "" }
        : { ...address, country: market.countryCode },
      deliveryMethod: selectedMethod.method, paymentMethod: payment,
      ...(gift && { gift: { note: giftNote } }),
      ...(marketplace && coupon.trim() && { couponCode: coupon.trim() }),
    };
    void run("REVIEW", async () => {
      const result = await checkoutRequest<ReviewResult>(marketId, { action: "review", checkout: input }, payment === "SSLCOMMERZ");
      if (result.kind !== "review") {
        reportStep("REVIEW", checkoutFailureCode(result.kind));
        setNotice({ ...result, error: true });
        return;
      }
      reportStep("REVIEW");
      setReview({ input, quote: result.quote, attemptId: result.attemptId });
      requestAnimationFrame(() => summary.current?.focus());
    }, "Couldn’t review this order. Your cart is still saved.");
  }

  function placeOrder() {
    if (!confirmed || inFlight.current) return;
    const prepaid = confirmed.input.paymentMethod === "SSLCOMMERZ";
    if (locked && prepaid) return;
    reportStep("SUBMIT");
    rememberPending(marketId, confirmed.attemptId, Boolean(directItem), prepaid);
    void run("SUBMIT", async () => {
      const result = await checkoutRequest<SubmitResult | PrepaidPaymentResult>(marketId, {
        action: prepaid ? "start" : "submit",
        checkout: { ...confirmed.input, attemptId: confirmed.attemptId, reviewToken: confirmed.quote.reviewToken },
        ...(prepaid && { direct: Boolean(directItem) }),
      }, prepaid);
      if (result.kind === "placed") { await finish(result, Boolean(directItem)); return; }
      if (result.kind === "continue") {
        reportStep("PROVIDER_REDIRECT");
        window.location.assign(result.redirectUrl);
        return;
      }
      if (result.kind === "pending") { setNotice({ message: result.message }); return; }
      rememberPending(marketId, null);
      reportStep("SUBMIT", checkoutFailureCode(result.kind));
      if (result.kind === "changed") {
        setReview({ ...confirmed, quote: result.quote });
        setNotice({ message: "Your order total changed. Check the updated total before continuing." });
        return;
      }
      setNotice({ ...result, error: true });
      setReview(null);
    }, prepaid ? "We couldn’t open the payment page. Check the status before trying again."
      : "We couldn’t confirm whether the order was placed. Check for a saved order.");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmed) placeOrder();
    else reviewOrder();
  }

  if (!ready) return <div className="state-panel" role="status">{sync === "error" ? <>
    <p>{syncMessage}</p><button type="button" className="button button--outline" onClick={retrySync}>Retry cart sync</button>
  </> : "Loading your cart…"}</div>;
  const message = notice && (
    <div className={`commerce-message${notice.error ? " commerce-message--error" : ""}`} role={notice.error ? "alert" : "status"}>
      <p>{notice.message}</p>
      {notice.issues && <ul>{notice.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    </div>
  );
  const recovering = callback ? { id: callback, prepaid: true } : pendingAttempt;

  if (recovering) return (
    <section className="commerce-panel commerce-form checkout-status">
      <h2>{recovering.prepaid ? "Check your payment" : "Check your last order"}</h2>
      <p>{recovering.prepaid ? "Your cart stays saved while the payment is confirmed." : "Check whether your order was saved before trying again."}</p>
      {message}
      <div className="checkout-status-actions">
        <button className="button button--primary" type="button" disabled={busy} onClick={() => void recoverOrder(recovering.id, recovering.prepaid)}>
          {busy ? "Checking…" : recovering.prepaid ? "Check payment status" : "Check for saved order"}
        </button>
        {recovering.prepaid && !callback && !busy && <button className="button button--outline" type="button"
          onClick={() => void recoverOrder(recovering.id, true, true)}>Return to payment</button>}
      </div>
    </section>
  );

  if (!choices.length && !prepaidChoices.length) {
    return <>{destinationControl}<div className="state-panel"><p>Checkout is unavailable for this market.</p><Link href="/cart" className="button button--primary">Back to cart</Link></div></>;
  }
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
  if (!items.length) {
    return <>{destinationControl}<div className="state-panel"><p>Your cart is empty.</p><Link href="/shop" className="button button--primary">Browse products</Link></div></>;
  }

  return (
    <form className="commerce-layout checkout-linear" onSubmit={submit} onInvalid={reportInvalidAddress}>
      <div className="commerce-stack">
        {directName && <p className="checkout-direct"><strong>Buy it now</strong> · {directName} × {directItem?.quantity}</p>}
        <fieldset className="commerce-panel commerce-form" disabled={busy}>
          <legend className="sr-only">Contact and delivery address</legend>
          <h2><span className="checkout-section-number" aria-hidden="true">1</span> Delivery address</h2>
          {demo && <p className="commerce-muted">Use sample contact and address details for this test order.</p>}
          {destinationControl}
          {addresses.length > 0 && <label>Saved addresses<select defaultValue="" onChange={event => {
            invalidateQuote();
            setAddress(addresses.find(item => item.id === event.target.value)?.value ?? { ...initialAddress, ...shopperAddress });
            setMethod("");
          }}><option value="">Enter a new address</option>{addresses.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
          <label>Full name<input required autoComplete="name" minLength={2} maxLength={100} value={address.name} onChange={event => updateAddress("name", event.target.value)} /></label>
          <div className="commerce-fields">
            <label>Phone number<input required type="tel" autoComplete="tel" maxLength={28} placeholder={postalAddress ? "(212) 555-0100" : "01XXXXXXXXX"} value={address.phone} onChange={event => updateAddress("phone", event.target.value)} /></label>
            <label>{payment === "COD" ? "Email (optional)" : "Email"}<input required={payment !== "COD"} type="email" autoComplete="email" maxLength={254} value={address.email} onChange={event => updateAddress("email", event.target.value)} /></label>
          </div>
          <label>Street address<input required autoComplete="street-address" minLength={5} maxLength={240} placeholder={postalAddress ? "Street and unit number" : "House, road, building or landmark"} value={address.address} onChange={event => updateAddress("address", event.target.value)} /></label>
          <div className="commerce-fields">
            <label>{districtLabel}<select required autoComplete="address-level1" value={address.district} onChange={event => updateAddress("district", event.target.value)}>
              <option value="">Choose {postalAddress ? "a state" : "a district"}</option>
              {districts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select></label>
            <label>{postalAddress ? "City" : "Area or upazila"}<input required autoComplete="address-level2" minLength={2} maxLength={100} value={address.locality} onChange={event => updateAddress("locality", event.target.value)} /></label>
          </div>
          <label>{postalAddress ? "ZIP code" : "Postal code (optional)"}<input required={postalAddress} autoComplete="postal-code" inputMode="numeric"
            pattern={postalAddress ? "[0-9]{5}(?:-[0-9]{4})?" : "[0-9]{4}"} maxLength={postalAddress ? 10 : 4} value={address.postalCode ?? ""} onChange={event => updateAddress("postalCode", event.target.value)} /></label>
        </fieldset>
        <fieldset className="commerce-panel commerce-form" disabled={busy}>
          <legend className="sr-only">Delivery and payment</legend>
          <h2><span className="checkout-section-number" aria-hidden="true">2</span> Delivery and payment</h2>
          <div className="commerce-option-heading"><Truck size={18} aria-hidden="true" /> Delivery</div>
          {methods.length === 0 && <p className="commerce-muted">Choose your {districtLabel.toLowerCase()} to see delivery options.</p>}
          {methods.map(option => (
            <label className="commerce-option checkout-payment-choice" key={option.method}>
              <input type="radio" name="delivery" checked={selectedMethod?.method === option.method} onChange={() => { invalidateQuote(); setMethod(option.method); }} />
              <span>{option.label}{option.guidance && <small>{option.guidance}</small>}</span>
              <strong>{formatMoney(option.chargeMinor, market)}</strong>
            </label>
          ))}
          <div className="commerce-option-heading"><CreditCard size={18} aria-hidden="true" /> Payment</div>
          <label className="commerce-option checkout-payment-choice">
            <input type="radio" name="payment" checked={payment === "COD"} disabled={!choices.length}
              onChange={() => { invalidateQuote(); setPayment("COD"); setMethod(""); }} />
            <span><strong>Full cash on delivery</strong><small>Pay the full {market.currency} total when your order arrives.</small></span>
          </label>
          {marketplace && <label className="commerce-option checkout-payment-choice">
            <input type="radio" name="payment" checked={payment === "SSLCOMMERZ"} disabled={!prepaidChoices.length}
              onChange={() => { invalidateQuote(); setPayment("SSLCOMMERZ"); setMethod(""); }} />
            <span><strong>Pay in full online</strong><small>{prepaidChoices.length ? "Pay securely on the SSLCOMMERZ test page." : "Online payment is unavailable for this checkout."}</small></span>
            <span className="checkout-save">Extra 5% off</span>
          </label>}
        </fieldset>
        {directPersonalization && <fieldset className="commerce-panel commerce-form" disabled={busy}>
          <legend className="sr-only">Personalization</legend>
          <PersonalizationField settings={directPersonalization} value={directText} onChange={value => {
            invalidateQuote();
            setPersonalizationDraft(value);
          }}/>
        </fieldset>}
        {marketplace && <details className="commerce-panel checkout-extras">
          <summary>Coupon or gift options</summary>
          <div className="commerce-form">
            <label className="store-dialog__field">Coupon code
              <input value={coupon} disabled={busy} onChange={event => { invalidateQuote(); setCoupon(event.target.value); }} maxLength={32} autoCapitalize="characters"
                pattern="[A-Za-z0-9](?:[A-Za-z0-9]|-){2,31}" autoComplete="off" />
            </label>
            <label className="mp-remember"><input type="checkbox" checked={gift} disabled={busy} onChange={event => {
              invalidateQuote();
              setGift(event.target.checked);
            }}/> Mark order as a gift</label>
            {gift && <label className="store-dialog__field">Gift message (optional)<input maxLength={240} value={giftNote} disabled={busy} onChange={event => {
              invalidateQuote();
              setGiftNote(event.target.value);
            }}/></label>}
          </div>
        </details>}
      </div>
      <aside className="commerce-stack checkout-linear-summary" ref={summary} tabIndex={-1} aria-label="Review and place order">
        {message}
        {confirmed ? <OrderBreakdown totals={confirmed.quote} market={market} heading="Review your order" /> :
          <section className="commerce-panel">
            <h2>Order summary</h2>
            <p>{items.reduce((count, item) => count + item.quantity, 0)} items in this order</p>
            <p className="commerce-muted">Enter your address to confirm the total.</p>
          </section>}
        {confirmed && <details className="commerce-panel checkout-extras">
          <summary>View order items</summary>
          <PurchasedItems lines={confirmed.quote.lines} market={market} />
        </details>}
        <button className="button button--primary" type="submit" disabled={busy || !selectedMethod || !validPersonalization}>
          {busy ? "Checking order…" : !confirmed ? "Review order" : payment === "COD" ? "Place COD order" : `Pay ${formatMoney(confirmed.quote.totalMinor, market)}`}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        {confirmed && <p className="commerce-muted checkout-disclaimer">
          {payment === "COD" ? "Payment method: Cash on delivery" : "Payment method: Full prepaid"}
        </p>}
      </aside>
    </form>
  );
}
