"use client";

import { ArrowRight, CreditCard, Truck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatMoney, markets } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { rememberPending, usePendingCheckout } from "@/lib/cart/checkout-attempt";
import { useCheckoutMeasurement } from "@/lib/measurement/browser";
import type {
  CheckoutDetails, CheckoutQuote, DeliveryChoice, NativeCheckoutDetails, OrderPlaced, PrepaidPaymentResult,
  RecoverResult, ReviewResult, SubmitResult,
} from "@/lib/commerce/checkout-types";
import { isManualPaymentMethod, manualPaymentLabels, manualReceiptLimit, type ManualPaymentInstructions } from "@/lib/commerce/manual-payment-methods";
import { compareCartItems, type CartItem } from "@/lib/cart/model";
import { clearBuyPersonalization, useBuyPersonalization } from "@/lib/cart/buy-personalization";
import { personalizationAvailable, personalizationText, type Personalization } from "@/lib/catalog/personalization";
import { checkoutContact, type CheckoutContactBinding } from "@/lib/commerce/checkout-contact";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { OrderBreakdown, PurchasedItems } from "./order-summary";
import { PersonalizationField } from "./personalization-field";
import { addressDistrictName, SaveCheckoutAddress } from "./marketplace/address-book";
import "./checkout-view.css";

const market = markets.bd;
type Address = CheckoutDetails["customer"];
type BangladeshInput = NativeCheckoutDetails;
type Review = { input: BangladeshInput; quote: CheckoutQuote; attemptId: string };
type Notice = { message: string; issues?: string[]; error?: boolean };
const initialAddress: Address = { name: "", phone: "", email: "", district: "", locality: "", address: "",
  postalCode: "", landmark: "", alternatePhone: "", instructions: "" };

async function checkoutRequest<T>(body: object, prepaid = false, receipt?: File): Promise<T> {
  const payload = JSON.stringify(body);
  const multipart = receipt ? new FormData() : null;
  if (receipt && multipart) {
    multipart.set("payload", payload);
    multipart.set("receipt", receipt);
  }
  const response = await fetch(storefrontPath(prepaid ? "/api/checkout/prepaid" : "/api/checkout"), {
    method: "POST", headers: multipart ? undefined : { "Content-Type": "application/json" }, body: multipart ?? payload,
  });
  if (response.status >= 500) throw new Error("Checkout response unavailable");
  return response.json() as Promise<T>;
}

export type CheckoutAddress = { id: string; label: string; value: Address; isDefault: boolean };

export function CheckoutView({ choices, manualChoices = [], manualMethods = [], directItem, directName, directPersonalization, personalizationIntent,
  marketplace = false, addresses = [], shopperAddress, destinationControl, prepaidAttempt, demo = false, contact,
  canSaveAddress = false, language = "en" }: {
  choices: readonly DeliveryChoice[];
  manualChoices?: readonly DeliveryChoice[];
  manualMethods?: readonly ManualPaymentInstructions[];
  directItem?: CartItem; directName?: string; marketplace?: boolean;
  directPersonalization?: Personalization; personalizationIntent?: string;
  addresses?: readonly CheckoutAddress[]; shopperAddress?: Partial<Address>;
  destinationControl?: ReactNode;
  prepaidAttempt?: string;
  demo?: boolean;
  contact?: CheckoutContactBinding;
  canSaveAddress?: boolean;
  language?: AccountLanguage;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const router = useRouter();
  const { ready, items: cartItems } = useCart();
  const { completePurchase } = useCartActions();
  const carriedText = useBuyPersonalization(personalizationIntent, directItem?.variantId);
  const [personalizationDraft, setPersonalizationDraft] = useState<string | null>(null);
  const directText = directPersonalization ? (personalizationDraft ?? carriedText) : "";
  const personalization = personalizationText(directText);
  const validPersonalization = (!directText.trim() || Boolean(personalization)) &&
    personalizationAvailable(directPersonalization, personalization);
  const items = directItem ? [{ ...directItem, ...(personalization && { personalization }) }] : cartItems;
  const pendingAttempt = usePendingCheckout();
  const [callback, setCallback] = useState(prepaidAttempt);
  const [addressDraft, setAddressDraft] = useState({ ...initialAddress, ...shopperAddress });
  const address = { ...addressDraft, ...contact?.value };
  const [gift, setGift] = useState(false);
  const [giftNote, setGiftNote] = useState("");
  const [coupon, setCoupon] = useState("");
  const [method, setMethod] = useState("");
  const [payment, setPayment] = useState<BangladeshInput["paymentMethod"]>(choices.length ? "COD" : manualMethods[0]?.method ?? "COD");
  const [proofKind, setProofKind] = useState<"transaction" | "receipt">("transaction");
  const [payerPhone, setPayerPhone] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const [receipt, setReceipt] = useState<File>();
  const [manualReviewBlocked, setManualReviewBlocked] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const verifiedCallback = useRef<string>(null);
  const summary = useRef<HTMLElement>(null);
  const activeChoices = payment === "COD" ? choices : manualChoices;
  const districts = [...new Map(activeChoices.map(choice => [choice.district, choice.districtLabel])).entries()];
  const usableAddresses = addresses.filter(item => districts.some(([district]) => district === item.value.district));
  const methods = activeChoices.filter(({ district }) => district === address.district);
  const selectedMethod = methods.find(choice => choice.method === method) ?? methods[0];
  const locked = Boolean(pendingAttempt || callback);
  const cartChanged = Boolean(review && JSON.stringify([...items].sort(compareCartItems)) !==
    JSON.stringify([...review.input.items].sort(compareCartItems)));
  const confirmed = review && !cartChanged ? review : null;
  useCheckoutMeasurement(ready && activeChoices.length > 0 && items.length > 0 && !locked);

  function clearProof() {
    setReceipt(undefined);
    setPayerPhone("");
    setTransactionId("");
  }

  function invalidateQuote() {
    setReview(null);
    setNotice(null);
    setManualReviewBlocked(false);
    clearProof();
  }

  function updateAddress(key: keyof Address, value: string) {
    invalidateQuote();
    if (contact && (key === "name" || key === "email" || key === "phone")) {
      contact.onChange({ ...contact.value, [key]: value });
    } else {
      setAddressDraft(previous => ({ ...previous, [key]: value }));
    }
    if (key === "district") setMethod("");
  }

  async function run(task: () => Promise<void>, failedMessage: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await task();
    } catch {
      setNotice({ message: failedMessage, error: true });
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function finish(order: OrderPlaced, direct: boolean) {
    if (!direct) await completePurchase(order.orderId, order.purchased);
    if (direct) clearBuyPersonalization(personalizationIntent, directItem?.variantId);
    rememberPending(null);
    router.replace(`${demo ? "/bd" : ""}/orders/${order.orderId}`);
  }

  function clearCallback() {
    if (!callback) return;
    setCallback(undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete("prepaid");
    window.history.replaceState(null, "", url);
  }

  async function recoverOrder(attemptId: string, prepaid: boolean, resume = false) {
    await run(async () => {
      const result = await checkoutRequest<RecoverResult | PrepaidPaymentResult>({ action: "recover", attemptId, ...(prepaid && { resume }) }, prepaid);
      if (result.kind === "placed") {
        await finish(result, "direct" in result ? result.direct : Boolean(pendingAttempt?.direct));
        return;
      }
      if (result.kind === "continue") {
        window.location.assign(result.redirectUrl);
        return;
      }
      if ("message" in result) {
        setNotice({ ...result, error: result.kind !== "pending" && result.kind !== "abandoned" });
      }
      if (result.kind === "abandoned") {
        rememberPending(null);
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
    if (!selectedMethod || locked || !validPersonalization) return;
    clearProof();
    const input: BangladeshInput = { marketId: "bd", items: [...items],
      customer: destinationControl ? { ...address, country: "BD" } : address,
      deliveryMethod: selectedMethod.method, paymentMethod: payment,
      ...(gift && { gift: { note: giftNote } }),
      ...(marketplace && coupon.trim() && { couponCode: coupon.trim() }),
    };
    void run(async () => {
      const result = await checkoutRequest<ReviewResult>({ action: "review", checkout: input });
      if (result.kind !== "review") { setNotice({ ...result, error: true }); return; }
      setReview({ input, quote: result.quote, attemptId: result.attemptId });
      requestAnimationFrame(() => summary.current?.focus());
    }, "Couldn’t review this order. Your cart is still saved.");
  }

  function placeOrder() {
    if (!confirmed || inFlight.current || locked || manualReviewBlocked) return;
    const manual = confirmed.quote.manualPayment;
    const file = manual && proofKind === "receipt" ? receipt : undefined;
    if (manual && proofKind === "receipt" && (!file || file.size > manualReceiptLimit || !/^image\/(jpeg|png|webp)$/.test(file.type))) {
      setNotice({ message: "Upload a JPEG, PNG, or WebP receipt up to 4 MB.", error: true });
      return;
    }
    const manualProof = manual ? proofKind === "receipt" ? { kind: "receipt" }
      : { kind: "transaction", payerPhone, transactionId } : undefined;
    rememberPending(confirmed.attemptId, Boolean(directItem));
    void run(async () => {
      const result = await checkoutRequest<SubmitResult>({
        action: "submit",
        checkout: { ...confirmed.input, attemptId: confirmed.attemptId, reviewToken: confirmed.quote.reviewToken, manualProof },
      }, false, file);
      if (result.kind === "placed") { await finish(result, Boolean(directItem)); return; }
      rememberPending(null);
      if (result.kind === "changed" && !manual) {
        setReview({ ...confirmed, quote: result.quote });
        setNotice({ message: "Your order total changed. Check the updated total before continuing." });
        return;
      }
      if (manual) {
        if (result.kind === "invalid") { setNotice({ ...result, error: true }); return; }
        if (manual.test) {
          invalidateQuote();
          setNotice({ message: "The test order could not be submitted. Review it again and use new sample proof.", error: true });
          return;
        }
        setManualReviewBlocked(true);
        setNotice({ message: "The checkout changed before the order could be saved. If you already transferred money, contact support with your transaction reference before paying again.", error: true });
        return;
      }
      if (result.kind !== "changed") setNotice({ ...result, error: true });
      setReview(null);
    }, "We couldn’t confirm whether the order was placed. Check for a saved order before trying again.");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmed) placeOrder();
    else reviewOrder();
  }

  if (!ready) return <p className="state-panel" role="status">Loading your cart…</p>;
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

  if (!choices.length && !manualChoices.length) {
    return <>{destinationControl}<div className="state-panel"><p>Checkout is unavailable for this market.</p><Link href="/cart" className="button button--primary">Back to cart</Link></div></>;
  }
  if (!items.length) {
    return <>{destinationControl}<div className="state-panel"><p>Your cart is empty.</p><Link href="/shop" className="button button--primary">Browse products</Link></div></>;
  }

  return (
    <form className="commerce-layout checkout-linear" onSubmit={submit}>
      <div className="commerce-stack">
        {directName && <p className="checkout-direct"><strong>Buy it now</strong> · {directName} × {directItem?.quantity}</p>}
        <fieldset className="commerce-panel commerce-form" disabled={busy}>
          <legend className="sr-only">{t("Contact and delivery address", "যোগাযোগ ও ডেলিভারির ঠিকানা")}</legend>
          <h2><span className="checkout-section-number" aria-hidden="true">1</span> {t("Delivery address", "ডেলিভারির ঠিকানা")}</h2>
          {demo && <p className="commerce-muted">{t("Use sample contact and address details for this test order.", "এই পরীক্ষামূলক অর্ডারে নমুনা যোগাযোগ ও ঠিকানা ব্যবহার করুন।")}</p>}
          {destinationControl}
          {usableAddresses.length > 0 && <label>{t("Saved addresses", "সংরক্ষিত ঠিকানা")}<select defaultValue="" onChange={event => {
            invalidateQuote();
            const selected = usableAddresses.find(item => item.id === event.target.value)?.value ?? { ...initialAddress, ...shopperAddress };
            setAddressDraft(selected);
            contact?.onChange(checkoutContact(selected), event.target.value ? "saved-address" : "new-address");
            setMethod("");
          }}><option value="">{t("Enter a new address", "নতুন ঠিকানা দিন")}</option>{usableAddresses.map(item => <option key={item.id} value={item.id}>
            {item.label}{item.isDefault && t(" (default)", " (ডিফল্ট)")}</option>)}</select></label>}
          <label>{t("Full name", "প্রাপকের পুরো নাম")}<input required autoComplete="name" minLength={2} maxLength={100} value={address.name} onChange={event => updateAddress("name", event.target.value)} /></label>
          <div className="commerce-fields">
            <label>{t("Phone number", "মোবাইল নম্বর")}<input required type="tel" autoComplete="tel" maxLength={28} placeholder="01XXXXXXXXX" value={address.phone} onChange={event => updateAddress("phone", event.target.value)} /></label>
            <label>{t("Email (optional)", "ইমেইল (ঐচ্ছিক)")}<input type="email" autoComplete="email" maxLength={254} value={address.email} onChange={event => updateAddress("email", event.target.value)} /></label>
          </div>
          <label>{t("Street address", "বাড়ি ও রাস্তার ঠিকানা")}<input required autoComplete="street-address" minLength={5} maxLength={240}
            placeholder={t("House, road or building", "বাড়ি, রাস্তা বা ভবন")} value={address.address} onChange={event => updateAddress("address", event.target.value)} /></label>
          <div className="commerce-fields">
            <label>{t("District", "জেলা")}<select required value={address.district} onChange={event => updateAddress("district", event.target.value)}>
              <option value="">{t("Choose a district", "জেলা নির্বাচন করুন")}</option>
              {districts.map(([id, label]) => <option key={id} value={id}>{addressDistrictName({ id, label }, language)}</option>)}
            </select></label>
            <label>{t("Area or upazila", "এলাকা বা উপজেলা")}<input required autoComplete="address-level2" minLength={2} maxLength={100} value={address.locality} onChange={event => updateAddress("locality", event.target.value)} /></label>
          </div>
          <label>{t("Postal code (optional)", "পোস্টকোড (ঐচ্ছিক)")}<input autoComplete="postal-code" inputMode="numeric" pattern="[0-9০-৯]{4}" maxLength={4} value={address.postalCode} onChange={event => updateAddress("postalCode", event.target.value)} /></label>
          {marketplace && <details>
            <summary>{t("More delivery details (optional)", "অতিরিক্ত ডেলিভারি তথ্য (ঐচ্ছিক)")}</summary>
            <div className="commerce-form">
              <label>{t("Landmark", "কাছের পরিচিত স্থান")}<input maxLength={120} value={address.landmark ?? ""} onChange={event => updateAddress("landmark", event.target.value)} /></label>
              <label>{t("Alternate phone", "বিকল্প মোবাইল নম্বর")}<input type="tel" maxLength={28} value={address.alternatePhone ?? ""} onChange={event => updateAddress("alternatePhone", event.target.value)} /></label>
              <label>{t("Delivery instructions", "ডেলিভারির নির্দেশনা")}<input maxLength={180} value={address.instructions ?? ""} onChange={event => updateAddress("instructions", event.target.value)} /></label>
            </div>
          </details>}
          {canSaveAddress && <SaveCheckoutAddress marketId="bd" language={language} details={{ ...address, country: "BD" }} />}
        </fieldset>
        <fieldset className="commerce-panel commerce-form" disabled={busy}>
          <legend className="sr-only">Delivery and payment</legend>
          <h2><span className="checkout-section-number" aria-hidden="true">2</span> Delivery and payment</h2>
          <div className="commerce-option-heading"><Truck size={18} aria-hidden="true" /> Delivery</div>
          {methods.length === 0 && <p className="commerce-muted">Choose your district to see delivery options.</p>}
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
            <span><strong>Full cash on delivery</strong><small>Pay the full BDT total when your order arrives.</small></span>
          </label>
          {manualChoices.length > 0 && manualMethods.map(wallet => (
            <label className="commerce-option checkout-payment-choice" key={wallet.method}>
              <input type="radio" name="payment" checked={payment === wallet.method}
                onChange={() => { invalidateQuote(); setPayment(wallet.method); setMethod(""); }} />
              <span><strong>{manualPaymentLabels[wallet.method]}</strong>
                <small>{wallet.test ? "Test wallet payment" : "Pay the BDT total by wallet transfer."}</small></span>
            </label>
          ))}
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
        {confirmed?.quote.manualPayment && !manualReviewBlocked && <fieldset className="commerce-panel commerce-form" disabled={busy}>
          <legend className="sr-only">Wallet payment proof</legend>
          <h2>{manualPaymentLabels[confirmed.quote.manualPayment.method]} payment</h2>
          {confirmed.quote.manualPayment.test ? <>
            <p><strong>Test checkout. Do not transfer real money.</strong></p>
            <p>Example receiving number <strong>{confirmed.quote.manualPayment.recipient}</strong>. Use a sample receipt or test transaction details.</p>
          </> : <p>Send <strong>{formatMoney(confirmed.quote.totalMinor, market)}</strong> to
            <strong> {confirmed.quote.manualPayment.recipient}</strong> using your wallet, then share your proof below.</p>}
          <label>Proof of payment<select value={proofKind} onChange={event => { clearProof(); setProofKind(event.target.value === "receipt" ? "receipt" : "transaction"); }}>
            <option value="transaction">Payer phone and transaction ID</option>
            <option value="receipt">Upload a payment receipt</option>
          </select></label>
          {proofKind === "receipt" ? <label>Payment receipt (JPEG, PNG, or WebP up to 4 MB)
            <input type="file" accept="image/jpeg,image/png,image/webp" required onChange={event => setReceipt(event.target.files?.[0])} />
          </label> : <>
            <label>Payer phone number<input type="tel" autoComplete="off" maxLength={28} required
              value={payerPhone} onChange={event => setPayerPhone(event.target.value)} /></label>
            <label>Transaction ID<input autoComplete="off" autoCapitalize="characters" required pattern="[A-Za-z0-9]{6,32}"
              value={transactionId} onChange={event => setTransactionId(event.target.value)} /></label>
          </>}
          <p className="commerce-muted">Your proof is private. GriipBuddy will verify it before preparing your order.</p>
        </fieldset>}
        {manualReviewBlocked && <Link className="button button--outline" href="/help">Contact support</Link>}
        <button className="button button--primary" type="submit" disabled={busy || !selectedMethod || !validPersonalization || manualReviewBlocked}>
          {busy ? "Checking order…" : !confirmed ? "Review order" : payment === "COD" ? "Place COD order" : "Submit order for verification"}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        {confirmed && !manualReviewBlocked && <p className="commerce-muted checkout-disclaimer">
          {isManualPaymentMethod(payment) ? `Payment method: ${manualPaymentLabels[payment]}` : "Payment method: Cash on delivery"}
        </p>}
      </aside>
    </form>
  );
}
