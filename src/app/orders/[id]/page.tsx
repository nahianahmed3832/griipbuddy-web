import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Bell, CircleCheck } from "lucide-react";
import { OrderBreakdown, PurchasedItems } from "@/components/order-summary";
import { SavePrivateOrderLink } from "@/components/order-recovery";
import { OrderDocumentLink } from "@/components/marketplace/order-document-link";
import { markets } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { store } from "@/config/store";
import { storefrontPath } from "@/config/storefront-path";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { cashDueOnDelivery, customerOrderDate, customerOrderMoney, customerOrderState, customerOrderStatus, customerPaymentStatus, customerPaymentMethod } from "@/lib/commerce/account-order";
import { bangladeshOrderDocumentKind } from "@/lib/commerce/bd-order-document";
import { guestOrder, visibleOrderMarket } from "@/lib/commerce/orders";
import { orderRecoveryEnabled, receiptAccessCookie, recoveredReceiptGuestKey } from "@/lib/commerce/order-recovery";
import { recordedReturnTerms } from "@/lib/commerce/order-return-terms";
import { integratedCheckout, readRecoveredOrder } from "@/lib/commerce/integrated-checkout";
import { getShopper } from "@/lib/marketplace/auth";
import { bdOrderHubConfig } from "@/lib/marketplace/bd-order-hub-bridge";
import { getDb } from "@/lib/db/client";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { storeShop } from "@/lib/marketplace/constants";
import { ClaimOrder, OrderHelp, ReviewPurchase } from "@/components/marketplace/purchase-actions";
import { PurchaseCases } from "@/components/marketplace/case-panels";
import { BangladeshTrackingTimeline } from "@/components/bangladesh-tracking";
import { isManualPaymentMethod } from "@/lib/commerce/manual-payment-methods";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { uuid } from "@/lib/commerce/checkout-types";
import "../order-history.css";

export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function ConfirmationPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ item?: string }>;
}) {
  const [{ id }, jar, active, selected] = await Promise.all([params, cookies(), currentMarket(), searchParams]);
  if (!uuid.safeParse(id).success) notFound();
  const guestKey = readGuestKey(jar.get(guestCookie)?.value);
  const marketplace = marketplaceMode();
  const regional = hybridDemoMode();
  const activeMarket = marketplace ? active.id : undefined;
  const shopper = marketplace ? await getShopper() : null;
  const saved = guestKey && (!activeMarket || activeMarket === "bd") && integratedCheckout() ? await readRecoveredOrder(id, guestKey) : null;
  const directOrder = !saved && (guestKey || shopper) ? await guestOrder(id, guestKey, shopper?.id, activeMarket) : null;
  const recoveryEnabled = orderRecoveryEnabled();
  const recoveryKey = !saved && !directOrder && recoveryEnabled
    ? await recoveredReceiptGuestKey(id, jar.get(receiptAccessCookie)?.value, activeMarket) : null;
  const nativeOrder = directOrder ?? (recoveryKey ? await guestOrder(id, recoveryKey, undefined, activeMarket) : null);
  const recoveredView = Boolean(recoveryKey);
  if (!saved && !nativeOrder && regional && (shopper || guestKey)) {
    // An authorized shopper can return to the original country's receipt without loading its details in this market.
    const original = await visibleOrderMarket(id, guestKey, shopper?.id);
    if (original && original.marketId !== active.id) redirect(storefrontPath(marketStoreHref("/orders/" + id, original.marketId)));
  }
  const order = saved ? {
    status: saved.status === "cancelled" ? "CANCELLED" as const : "PLACED" as const, reference: saved.number,
    marketId: "bd" as const, currency: "BDT" as const, fulfillmentStatus: saved.fulfillment,
    createdAt: new Date(saved.createdAt), updatedAt: new Date(saved.createdAt),
    customerName: saved.destination.name, address: saved.destination.address, locality: saved.destination.city,
    districtLabel: saved.destination.state, phone: saved.destination.phone, postalCode: saved.destination.postal,
    deliveryLabel: "Standard delivery", deliveryGuidance: null, carrier: saved.tracking ? "Recorded handoff" : null,
    trackingReference: saved.tracking,
    subtotalMinor: saved.original.merchandiseMinor, discountMinor: saved.original.discountMinor,
    deliveryMinor: saved.original.shippingMinor, taxMinor: saved.original.taxMinor, taxLabel: "Tax (trial)", totalMinor: saved.total,
    items: saved.original.lines.map(line => ({
      variantId: line.variantId, productName: line.title, variantName: Object.values(line.attributes ?? {}).join(" / "),
      sku: line.sku, quantity: line.quantity, unitPriceMinor: line.unitMinor, unitDiscountMinor: 0,
      lineTotalMinor: line.unitMinor * line.quantity - line.discountMinor,
    })),
    payment: { method: "COD" as const, status: saved.status === "cancelled" ? "VOIDED" as const :
      saved.payment === "paid" ? "COLLECTED" as const : "AWAITING_COLLECTION" as const,
      amountMinor: Math.max(0, saved.total - saved.paid), currency: "BDT" as const },
  } : nativeOrder;
  if (!order) notFound();

  const market = markets[order.marketId];
  const payment = order.payment;
  const language = await currentAccountLanguage(order.marketId);
  const returnTerms = nativeOrder ? recordedReturnTerms(nativeOrder) : null;
  const termsLanguage = returnTerms?.summary[language] ? language : "en";
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  const money = (amount: number) => customerOrderMoney(amount, order.currency, language);
  const regionalMarket = regional ? order.marketId : undefined;
  const orderHref = (path: string) => marketStoreHref(path, regionalMarket);
  const usSandbox = regionalMarket === "us" && payment?.method === "PAYPAL";
  const shipment = nativeOrder?.bangladeshShipment;
  const receivedAt = nativeOrder?.bangladeshRefusedParcelReceipt?.receivedAt;
  const latestUpdate = receivedAt ?? shipment?.statusUpdatedAt ?? order.updatedAt;
  const deliveryStatus = customerOrderStatus(nativeOrder ?? order, language);
  const pendingVerification = payment?.status === "AWAITING_VERIFICATION";
  const manualDeclined = payment && isManualPaymentMethod(payment.method) && payment.status === "VOIDED";
  const cashDue = cashDueOnDelivery(order);
  const owned = marketplace && nativeOrder && shopper && nativeOrder.shopperId === shopper.id;
  const showOrderUpdates = owned && active.id === "bd" && order.marketId === "bd" && Boolean(bdOrderHubConfig());
  const initialItemId = owned && uuid.safeParse(selected.item).data;
  const [shops, reviewItems, existingReviews] = owned ? await Promise.all([
    getDb().marketplaceShop.findMany({ where: { id: { in: [...new Set(nativeOrder.items.map(item => item.marketplaceShopId ?? storeShop.id))] }, published: true }, select: { id: true, name: true } }),
    order.fulfillmentStatus === "DELIVERED" ? getDb().product.findMany({ where: { variants: {
      some: { id: { in: nativeOrder.items.map(item => item.variantId) } },
    } }, select: { id: true, name: true } }) : [],
    getDb().shopperReview.findMany({ where: { orderId: id, shopperId: shopper.id }, select: { productId: true, text: true, stars: true, visible: true } }),
  ]) : [[], [], []];
  return (
    <div className="shell inner-page commerce-page" lang={language}>
      <nav className="breadcrumbs" aria-label={t("Order navigation", "অর্ডারের নেভিগেশন")}>
        <Link href={orderHref("/orders")}>{t("My orders", "আমার অর্ডার")}</Link>
      </nav>
      <div className="commerce-intro">
        <h1 className="display-type">
          {order.status === "PLACED" && !pendingVerification && <CircleCheck size={29} aria-hidden="true" />}
          {pendingVerification ? t("Order received", "অর্ডার পাওয়া গেছে") : order.status === "PLACED"
            ? t("Order confirmed", "অর্ডার নিশ্চিত হয়েছে") : t("Order cancelled", "অর্ডার বাতিল হয়েছে")}
        </h1>
        <p>{t("Order reference", "অর্ডার নম্বর")} <strong>{order.reference}</strong></p>
        <p><time dateTime={order.createdAt.toISOString()}>{customerOrderDate(order.createdAt, order.marketId, language, true)}</time></p>
        {owned && order.marketId === "bd" && <a className="text-link" href="#order-support">
          {t("Manage this order", "এই অর্ডার পরিচালনা করুন")}
        </a>}
        {showOrderUpdates && <div className="order-detail-actions">
          <Link className="button button--outline order-updates-link" href={orderHref(`/account/notifications?order=${id}`)}>
            <Bell size={17} aria-hidden="true" />{t("Updates for this order", "এই অর্ডারের আপডেট")}
          </Link>
          {order.currency === "BDT" && <OrderDocumentLink orderPath={`/orders/${id}`} reference={order.reference}
            kind={bangladeshOrderDocumentKind(payment)} language={language} className="button button--outline" />}
        </div>}
        {usSandbox && <p>United States · PayPal sandbox</p>}
      </div>
      <div className="commerce-layout">
        <div className="commerce-stack">
          <section className="commerce-panel">
            <h2>{t("Purchased items", "অর্ডার করা পণ্য")}</h2>
            <PurchasedItems lines={order.items} market={market} currency={order.currency} language={language} showPersonalization={!recoveredView}
              itemHelpHref={owned ? item => storefrontPath(orderHref("/orders/" + id + "?item=" + encodeURIComponent(item) + "#order-support")) : undefined} />
            {marketplace && !recoveredView && nativeOrder?.gift && <p>{t("Gift order", "উপহারের অর্ডার")}{nativeOrder.giftNote && " · " + nativeOrder.giftNote}</p>}
            {owned && reviewItems.map(item => <ReviewPurchase key={item.id} id={id} item={{ productId: item.id, name: item.name }}
              marketId={order.marketId} language={language} saved={existingReviews.find(review => review.productId === item.id)} />)}
          </section>
          <section className="commerce-panel">
            <h2>{t("Delivery details", "ডেলিভারির বিবরণ")}</h2>
            {recoveredView ? <p>{t("Open this order in the original checkout browser or in your account to see the delivery address.",
              "ডেলিভারির ঠিকানা দেখতে যে ব্রাউজারে অর্ডার করেছিলেন সেখানে অথবা আপনার অ্যাকাউন্টে অর্ডারটি খুলুন।")}</p> : <>
              {usSandbox && <p>Sample delivery address</p>}
              <address>
                {order.customerName}<br />
                {order.address}<br />
                {order.locality}, {order.districtLabel}{order.postalCode && " " + order.postalCode}<br />
                {usSandbox && <>United States<br /></>}
                {order.phone}
              </address>
            </>}
            <p>{order.deliveryLabel === "Standard delivery" ? t("Standard delivery", "সাধারণ ডেলিভারি") : order.deliveryLabel}</p>
            {order.deliveryGuidance && <p>{order.deliveryGuidance}</p>}
            {shipment ? <section className="order-tracking" aria-label={t("Shipment tracking", "পার্সেল ট্র্যাকিং")}>
              <h3>{t("Shipment tracking", "পার্সেল ট্র্যাকিং")}</h3>
              <BangladeshTrackingTimeline shipment={shipment} receivedAt={receivedAt} language={language} />
            </section> : order.carrier && order.trackingReference ? <section className="order-tracking" aria-label={t("Shipment information", "পার্সেলের তথ্য")}>
              <h3>{t("Shipment information", "পার্সেলের তথ্য")}</h3>
              <p>{order.carrier} · {order.trackingReference}</p>
              <p className="commerce-muted">{usSandbox ? "Test tracking recorded by GriipBuddy staff."
                : t("Recorded by GriipBuddy staff.", "GriipBuddy কর্মীরা তথ্যটি যোগ করেছেন।")}</p>
            </section> : order.status === "PLACED" && <p>{usSandbox ? "Test tracking will appear when staff record shipment."
              : t("Tracking will appear when your shipment is recorded.", "পার্সেল পাঠানোর তথ্য যোগ হলে এখানে ট্র্যাকিং দেখা যাবে।")}</p>}
            <p className="commerce-muted">{t("Last updated", "সর্বশেষ আপডেট")} <time dateTime={latestUpdate.toISOString()}>{customerOrderDate(latestUpdate, order.marketId, language, true)}</time></p>
          </section>
        </div>
        <div className="commerce-stack">
          <section className="commerce-panel commerce-summary" aria-label={t("Payment and status", "পেমেন্ট ও অর্ডারের অবস্থা")}>
            <h2>{t("Payment and status", "পেমেন্ট ও অর্ডারের অবস্থা")}</h2>
            <dl>
              {payment && <div><dt>{t("Payment method", "পেমেন্ট পদ্ধতি")}</dt><dd>{customerPaymentMethod(payment.method, language)}</dd></div>}
              <div><dt>{t("Payment status", "পেমেন্টের অবস্থা")}</dt><dd>{!payment
                ? t("Payment details unavailable", "পেমেন্টের বিবরণ নেই") : manualDeclined
                  ? t("Payment declined", "পেমেন্ট গ্রহণ করা হয়নি") : customerPaymentStatus(payment.status, language)}</dd></div>
              <div><dt>{t("Order status", "অর্ডারের অবস্থা")}</dt><dd>{customerOrderState(order.status, language)}</dd></div>
              {order.status === "PLACED" && <div><dt>{t("Fulfillment", "ডেলিভারির অবস্থা")}</dt><dd>{deliveryStatus}</dd></div>}
              {cashDue !== null && <div className="commerce-summary__total"><dt>{t("Amount due on delivery", "ডেলিভারির সময় পরিশোধযোগ্য")}</dt><dd>{money(cashDue)} {order.currency}</dd></div>}
              {pendingVerification && <div><dt>{t("Payment being verified", "পেমেন্ট যাচাই হচ্ছে")}</dt><dd>{money(payment.amountMinor)} {order.currency}</dd></div>}
              {payment?.status === "REFUNDED" && <div><dt>{t("Refund amount", "ফেরত দেওয়া টাকা")}</dt>
                <dd>{money(payment.amountMinor)} {order.currency} · {customerPaymentMethod(payment.method, language)}</dd></div>}
            </dl>
            {pendingVerification && <p>{t("We received your proof. Your order will be prepared after payment verification. Do not send another payment for this order.",
              "পেমেন্টের প্রমাণ পাওয়া গেছে। পেমেন্ট যাচাইয়ের পর অর্ডার প্রস্তুত করা হবে। এই অর্ডারে আবার টাকা পাঠাবেন না।")}</p>}
            {manualDeclined && <p>{t("We couldn’t verify the payment. If you sent money, contact support before trying again.",
              "পেমেন্ট যাচাই করা যায়নি। টাকা পাঠিয়ে থাকলে আবার চেষ্টা করার আগে সহায়তা নিন।")}</p>}
            <form method="get">
              {regionalMarket === "us" && <input name="market" type="hidden" value="us" />}
              <button type="submit" className="button button--outline">{t("Refresh status", "অবস্থা আপডেট করুন")}</button>
            </form>
          </section>
          <OrderBreakdown totals={recoveredView ? { ...order, couponCode: null } : order} market={market} currency={order.currency} language={language} />
          {recoveryEnabled && directOrder && !directOrder.shopperId && <SavePrivateOrderLink orderId={id} marketId={order.marketId} language={language} />}
          <section className="commerce-panel customer-info">
            <h2>{t("Need help with this order?", "এই অর্ডার নিয়ে সহায়তা দরকার?")}</h2>
            {returnTerms && <details>
              <summary>{t("Return terms for this order", "এই অর্ডারের ফেরতের শর্ত")}</summary>
              <p lang={termsLanguage}>{returnTerms.summary[termsLanguage]}</p>
            </details>}
            {owned && order.marketId !== "bd" && <p><a className="text-link" href="#order-support">{t("Request help or a return", "সহায়তা বা রিটার্নের অনুরোধ করুন")}</a></p>}
            <p><a href={"mailto:" + store.supportEmail + "?subject=" + encodeURIComponent("Order " + order.reference)}>{t("Email GriipBuddy", "GriipBuddy-কে ইমেইল করুন")}</a>
              {" "}{t("or read the", "অথবা পড়ুন")}{" "}<Link href={orderHref("/help/returns")}>{t("cancellation, return and refund information", "অর্ডার বাতিল, রিটার্ন ও টাকা ফেরতের তথ্য")}</Link>.</p>
            <p><Link href={orderHref("/orders")}>{t("Your recent orders", "সাম্প্রতিক অর্ডার")}</Link></p>
            {owned && shops.some(shop => shop.id !== storeShop.id) && <OrderHelp id={id} shops={shops.filter(shop => shop.id !== storeShop.id)} />}
            {marketplace && directOrder && !directOrder.shopperId && <ClaimOrder id={id} marketId={order.marketId} language={language} />}
          </section>
          {owned && <PurchaseCases order={nativeOrder} shopperId={shopper.id} market={order.marketId} language={language} initialItemId={initialItemId || undefined} />}
          <Link className="button button--outline" href={orderHref("/shop")}>{t("Continue shopping", "কেনাকাটা চালিয়ে যান")}</Link>
        </div>
      </div>
    </div>
  );
}
