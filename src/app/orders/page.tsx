import { cookies } from "next/headers";
import Link from "next/link";
import { BangladeshOrderHubForms } from "@/components/marketplace/bd-order-hub-forms";
import { LegacyOrderRow } from "@/components/marketplace/legacy-order";
import { SignInGate } from "@/components/marketplace/session";
import { marketList, type Currency, type MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { store } from "@/config/store";
import { storefrontPath } from "@/config/storefront-path";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { cashDueOnDelivery, customerOrderDate, customerOrderMoney, customerOrderStatus, customerPaymentStatus } from "@/lib/commerce/account-order";
import { listGuestOrders } from "@/lib/commerce/orders";
import { integratedCheckout, listRecoveredOrders } from "@/lib/commerce/integrated-checkout";
import { bangladeshTrackingUrl, usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { accountMarketName, accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { bdLegacyAccess } from "@/lib/marketplace/bd-order-hub";
import { bdOrderHubConfig, legacyCursor, legacyOrderHistory } from "@/lib/marketplace/bd-order-hub-bridge";
import { caseKindLabel, caseProgressLabel } from "@/lib/marketplace/case-language";
import { shopperOrders } from "@/lib/marketplace/data";
import { orderRecoveryEnabled } from "@/lib/commerce/order-recovery";
import { reportFailure } from "@/lib/db/observability";
import type { BangladeshShipmentStatus, FulfillmentStatus, OrderCaseKind, OrderCaseStatus, OrderStatus, PaymentMethod, PaymentStatus } from "@/generated/prisma/enums";
import "./order-history.css";

export const metadata = { title: "My orders", robots: { index: false, follow: false }, referrer: "no-referrer" };

type OrderListEntry = {
  id: string;
  reference: string;
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  createdAt: Date;
  marketId?: MarketId;
  currency?: Currency;
  totalMinor?: number;
  shopperId?: string | null;
  items?: { productName: string; quantity: number }[];
  _count?: { items: number };
  payment?: { amountMinor: number; currency: Currency; method: PaymentMethod; status: PaymentStatus } | null;
  bangladeshShipment?: { status: BangladeshShipmentStatus } | null;
  bangladeshRefusedParcelReceipt?: { receivedAt: Date } | null;
  cases?: { id: string; kind: OrderCaseKind; status: OrderCaseStatus; refundConfirmedAt: Date | null }[];
};

export default async function CustomerOrdersPage({ searchParams }: {
  searchParams: Promise<{ view?: string; before?: string }>;
}) {
  const [jar, active, params] = await Promise.all([cookies(), currentMarket(), searchParams]);
  const guestKey = readGuestKey(jar.get(guestCookie)?.value);
  const marketplace = marketplaceMode();
  const regional = hybridDemoMode();
  const [language, shopper] = await Promise.all([currentAccountLanguage(active.id), marketplace ? getShopper() : null]);
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  const href = (path: string) => marketStoreHref(path, regional ? active.id : undefined);
  const hub = active.id === "bd" && Boolean(bdOrderHubConfig());
  const view = hub && (params.view === "order" || params.view === "preorder") ? params.view : undefined;
  const before = hub && shopper ? legacyCursor.safeParse(params.before).data : undefined;
  const [orders, history]: [OrderListEntry[], Awaited<ReturnType<typeof historicalOrders>> | null] = await Promise.all([
    view === "preorder" || before ? [] : marketplace ? shopperOrders(shopper?.id, guestKey, active.id)
      : guestKey ? (integratedCheckout() ? listRecoveredOrders : listGuestOrders)(guestKey) : [],
    hub && shopper ? historicalOrders(shopper.id, view, before) : null,
  ]);
  const entries = [
    ...orders.map(order => ({ type: "current" as const, order, at: order.createdAt.getTime() })),
    ...(history?.items ?? []).map(order => ({ type: "historical" as const, order, at: Date.parse(order.createdAt) })),
  ].sort((left, right) => right.at - left.at);
  const verifiedPhone = shopper && "phoneNumberVerified" in shopper && shopper.phoneNumberVerified === true &&
    "phoneNumber" in shopper && typeof shopper.phoneNumber === "string" &&
    /^\+8801[3-9]\d{8}$/.test(shopper.phoneNumber) && shopper.phoneNumber !== "+8801700000000";
  const pageLink = (filter?: string, cursor?: string) => {
    const query = new URLSearchParams();
    if (filter) query.set("view", filter);
    if (cursor) query.set("before", cursor);
    return href(query.size ? `/orders?${query}` : "/orders");
  };
  const number = new Intl.NumberFormat(language === "bn" ? "bn-BD" : active.locale);
  return (
    <div className="shell inner-page commerce-page customer-info" lang={language}>
      <div className="commerce-intro">
        <h1 className="display-type">{shopper || hub ? t("My orders", "আমার অর্ডার") : t("Order status", "অর্ডারের অবস্থা")}</h1>
        {usesBangladeshCheckout() ? <p><a className="text-link" href={bangladeshTrackingUrl}>{t("Track a Bangladesh order on griipbuddy.com", "griipbuddy.com-এ বাংলাদেশের অর্ডার ট্র্যাক করুন")}</a></p>
          : <p>{hub ? t("Track Bangladesh orders and pre-orders, or recover an order you placed as a guest.",
            "বাংলাদেশের অর্ডার ও প্রি-অর্ডার ট্র্যাক করুন, অথবা অতিথি হিসেবে করা অর্ডার পুনরুদ্ধার করুন।") : shopper ? t("Open an order to track its delivery or get help.", "ডেলিভারি ট্র্যাক করতে বা সহায়তা পেতে অর্ডারটি খুলুন।")
            : t("Open a recent order in the browser you used for checkout.", "যে ব্রাউজারে অর্ডার করেছেন, সেখানে সাম্প্রতিক অর্ডার খুলুন।")}</p>}
        {regional && <nav className="mp-panel-links" aria-label={t("Order country", "অর্ডারের দেশ")}>
          {marketList.map(({ id }) => id === active.id
            ? <strong aria-current="true" key={id}>{accountMarketName(language, id)}</strong>
            : <a key={id} href={storefrontPath(marketStoreHref("/orders", id))}>{t("View orders in", "অর্ডার দেখুন:")} {accountMarketName(language, id)}</a>)}
        </nav>}
      </div>
      {hub && (shopper ? <BangladeshOrderHubForms language={language} linked={Boolean(history?.linked)} verifiedPhone={Boolean(verifiedPhone)}/>
        : <div className="commerce-panel bd-order-hub-forms"><SignInGate language={language}>
          {t("Sign in to see earlier purchases and recover a guest order on this device.", "আগের কেনাকাটা দেখতে এবং এই ডিভাইসে অতিথি অর্ডার পুনরুদ্ধার করতে সাইন ইন করুন।")}
        </SignInGate></div>)}
      {hub && <nav className="mp-panel-links bd-order-filters" aria-label={t("Order type", "অর্ডারের ধরন")}>
        <Link href={pageLink()} aria-current={view === undefined && !before ? "page" : undefined}>{t("All orders", "সব অর্ডার")}</Link>
        <Link href={pageLink("order")} aria-current={view === "order" && !before ? "page" : undefined}>{t("Orders", "অর্ডার")}</Link>
        <Link href={pageLink("preorder")} aria-current={view === "preorder" && !before ? "page" : undefined}>{t("Pre-orders", "প্রি-অর্ডার")}</Link>
      </nav>}
      {history?.unavailable && <p role="status">{t("Earlier purchases are temporarily unavailable.", "আগের কেনাকাটাগুলো সাময়িকভাবে দেখা যাচ্ছে না।")}</p>}
      {entries.length === 0 ? <section className="commerce-panel commerce-stack">
        <h2>{view === "preorder" ? t("No pre-orders to show", "দেখানোর মতো কোনো প্রি-অর্ডার নেই")
          : shopper ? t("No purchases to show", "দেখানোর মতো কোনো অর্ডার নেই") : t("No orders in this browser", "এই ব্রাউজারে কোনো অর্ডার নেই")}</h2>
        {orderRecoveryEnabled() && <p>{t("If you saved a private order link, open it to track the guest order.",
          "ব্যক্তিগত অর্ডার লিংক সংরক্ষণ করে থাকলে, অতিথি অর্ডার ট্র্যাক করতে সেটি খুলুন।")}</p>}
        <p>{t("Need help finding a guest order? Email", "অতিথি অর্ডার খুঁজতে সহায়তা দরকার? অর্ডার নম্বরসহ ইমেইল করুন")}
          {" "}<a href={"mailto:" + store.supportEmail}>{store.supportEmail}</a>{" "}{t("with your order reference.", "।")}</p>
        <Link className="button button--outline" href={href("/shop")}>{t("Continue shopping", "কেনাকাটা চালিয়ে যান")}</Link>
      </section> : <ul className="staff-orders account-order-list">
        {entries.map(entry => {
          if (entry.type === "historical") {
            const { order } = entry;
            return <LegacyOrderRow key={`${order.kind}-${order.id}`} order={order} href={href(`/orders/history/${order.kind}/${order.id}`)} language={language}/>;
          }
          const { order } = entry;
          const marketId = order.marketId ?? active.id;
          const orderPath = "/orders/" + order.id;
          const showAfterSales = marketId === "bd" && shopper && shopper.id === order.shopperId;
          const cashDue = order.currency ? cashDueOnDelivery({ ...order, marketId, currency: order.currency, payment: order.payment ?? null }) : null;
          const extra = (order._count?.items ?? 0) - (order.items?.length ?? 0);
          return <li className="staff-order-row commerce-panel account-order-row" key={order.id}>
            <div className="account-order-primary">
              <Link className="staff-order-ref" href={href(orderPath)}>{order.reference}
                <span className="sr-only"> {t("View order", "অর্ডার দেখুন")}</span>
              </Link>
              <time dateTime={order.createdAt.toISOString()}>{customerOrderDate(order.createdAt, marketId, language)}</time>
              {order.items && order.items.length > 0 && <ul className="account-order-items">
                {order.items.map((item, index) => <li key={item.productName + index}>{item.productName} × {number.format(item.quantity)}</li>)}
                {extra > 0 && <li>{t("More items", "আরও পণ্য")} · {number.format(extra)}</li>}
              </ul>}
              {showAfterSales && <div className="account-order-actions">
                <Link href={href(orderPath + "#order-support")}>{t("Manage order", "অর্ডার পরিচালনা করুন")}</Link>
                {order.cases?.map(request => {
                  const refund = request.refundConfirmedAt || request.status === "REFUND_APPROVED" || request.status === "REFUND_FAILED";
                  return <Link key={request.id} href={href(orderPath + "/cases/" + request.id + (refund ? "#refund-progress" : ""))}>
                    {refund ? t("Track refund", "টাকা ফেরত ট্র্যাক করুন") : caseKindLabel(language, request.kind)}
                    {" · "}{caseProgressLabel(language, request)}
                  </Link>;
                })}
              </div>}
            </div>
            <dl>
              <div><dt>{t("Delivery", "ডেলিভারি")}</dt><dd>{customerOrderStatus(order, language)}</dd></div>
              {order.payment && <div><dt>{t("Payment", "পেমেন্ট")}</dt><dd>{customerPaymentStatus(order.payment.status, language)}</dd></div>}
              {cashDue !== null && order.currency && <div><dt>{t("Amount due on delivery", "ডেলিভারির সময় পরিশোধযোগ্য")}</dt><dd>{customerOrderMoney(cashDue, order.currency, language)}</dd></div>}
              {order.totalMinor !== undefined && order.currency && <div><dt>{t("Order total", "অর্ডারের মোট")}</dt><dd>{customerOrderMoney(order.totalMinor, order.currency, language)} {order.currency}</dd></div>}
            </dl>
          </li>;
        })}
      </ul>}
      {(history?.next || before) && <nav className="mp-panel-links" aria-label={t("Order history pages", "অর্ডার ইতিহাসের পৃষ্ঠাগুলো")}>
        {before && <Link href={pageLink(view)}>{t("Back to newest", "সাম্প্রতিক অর্ডারে ফিরে যান")}</Link>}
        {history?.next && <Link href={pageLink(view, history.next)}>{t("Older orders", "পুরোনো অর্ডার")}</Link>}
      </nav>}
      <div className="mp-panel-links">
        {shopper && <Link href={href("/account")}>{t("My account", "আমার অ্যাকাউন্ট")}</Link>}
        <Link href={href("/help")}>{t("Help with orders", "অর্ডারের জন্য সহায়তা")}</Link>
      </div>
    </div>
  );
}

async function historicalOrders(shopperId: string, view?: "order" | "preorder", before?: string) {
  const access = await bdLegacyAccess(shopperId);
  const linked = Boolean(access.legacyCustomerId);
  if (!linked && !access.grants.length) return { items: [], next: null, linked, unavailable: false };
  try {
    return { ...await legacyOrderHistory(access, view, before), linked, unavailable: false };
  } catch (error) {
    reportFailure("bd-order-hub.history", undefined, error);
    return { items: [], next: null, linked, unavailable: true };
  }
}
