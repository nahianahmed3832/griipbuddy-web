import { cookies } from "next/headers";
import Link from "next/link";
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
import { shopperOrders } from "@/lib/marketplace/data";
import { orderRecoveryEnabled } from "@/lib/commerce/order-recovery";
import type { BangladeshShipmentStatus, FulfillmentStatus, OrderStatus, PaymentMethod, PaymentStatus } from "@/generated/prisma/enums";
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
  items?: { productName: string; quantity: number }[];
  _count?: { items: number };
  payment?: { amountMinor: number; currency: Currency; method: PaymentMethod; status: PaymentStatus } | null;
  bangladeshShipment?: { status: BangladeshShipmentStatus } | null;
  bangladeshRefusedParcelReceipt?: { receivedAt: Date } | null;
};

export default async function CustomerOrdersPage() {
  const [jar, active] = await Promise.all([cookies(), currentMarket()]);
  const guestKey = readGuestKey(jar.get(guestCookie)?.value);
  const marketplace = marketplaceMode();
  const regional = hybridDemoMode();
  const [language, shopper] = await Promise.all([currentAccountLanguage(active.id), marketplace ? getShopper() : null]);
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  const href = (path: string) => marketStoreHref(path, regional ? active.id : undefined);
  const orders: OrderListEntry[] = marketplace ? await shopperOrders(shopper?.id, guestKey, active.id)
    : guestKey ? await (integratedCheckout() ? listRecoveredOrders : listGuestOrders)(guestKey) : [];
  const number = new Intl.NumberFormat(language === "bn" ? "bn-BD" : active.locale);
  return (
    <div className="shell inner-page commerce-page customer-info" lang={language}>
      <div className="commerce-intro">
        <h1 className="display-type">{shopper ? t("My orders", "আমার অর্ডার") : t("Order status", "অর্ডারের অবস্থা")}</h1>
        {usesBangladeshCheckout() ? <p><a className="text-link" href={bangladeshTrackingUrl}>{t("Track a Bangladesh order on griipbuddy.com", "griipbuddy.com-এ বাংলাদেশের অর্ডার ট্র্যাক করুন")}</a></p>
          : <p>{shopper ? t("Open an order to track its delivery or get help.", "ডেলিভারি ট্র্যাক করতে বা সহায়তা পেতে অর্ডারটি খুলুন।")
            : t("Open a recent order in the browser you used for checkout.", "যে ব্রাউজারে অর্ডার করেছেন, সেখানে সাম্প্রতিক অর্ডার খুলুন।")}</p>}
        {regional && <nav className="mp-panel-links" aria-label={t("Order country", "অর্ডারের দেশ")}>
          {marketList.map(({ id }) => id === active.id
            ? <strong aria-current="true" key={id}>{accountMarketName(language, id)}</strong>
            : <a key={id} href={storefrontPath(marketStoreHref("/orders", id))}>{t("View orders in", "অর্ডার দেখুন:")} {accountMarketName(language, id)}</a>)}
        </nav>}
      </div>
      {orders.length === 0 ? <section className="commerce-panel commerce-stack">
        <h2>{shopper ? t("No purchases yet", "এখনো কোনো অর্ডার নেই") : t("No orders in this browser", "এই ব্রাউজারে কোনো অর্ডার নেই")}</h2>
        {orderRecoveryEnabled() && <p>{t("If you saved a private order link, open it to track the guest order.",
          "ব্যক্তিগত অর্ডার লিংক সংরক্ষণ করে থাকলে, অতিথি অর্ডার ট্র্যাক করতে সেটি খুলুন।")}</p>}
        <p>{t("Need help finding a guest order? Email", "অতিথি অর্ডার খুঁজতে সহায়তা দরকার? অর্ডার নম্বরসহ ইমেইল করুন")}
          {" "}<a href={"mailto:" + store.supportEmail}>{store.supportEmail}</a>{" "}{t("with your order reference.", "।")}</p>
        <Link className="button button--outline" href={href("/shop")}>{t("Continue shopping", "কেনাকাটা চালিয়ে যান")}</Link>
      </section> : <ul className="staff-orders account-order-list">
        {orders.map(order => {
          const marketId = order.marketId ?? active.id;
          const cashDue = order.currency ? cashDueOnDelivery({ ...order, marketId, currency: order.currency, payment: order.payment ?? null }) : null;
          const extra = (order._count?.items ?? 0) - (order.items?.length ?? 0);
          return <li className="staff-order-row commerce-panel account-order-row" key={order.id}>
            <div className="account-order-primary">
              <Link className="staff-order-ref" href={href("/orders/" + order.id)}>{order.reference}
                <span className="sr-only"> {t("View order", "অর্ডার দেখুন")}</span>
              </Link>
              <time dateTime={order.createdAt.toISOString()}>{customerOrderDate(order.createdAt, marketId, language)}</time>
              {order.items && order.items.length > 0 && <ul className="account-order-items">
                {order.items.map((item, index) => <li key={item.productName + index}>{item.productName} × {number.format(item.quantity)}</li>)}
                {extra > 0 && <li>{t("More items", "আরও পণ্য")} · {number.format(extra)}</li>}
              </ul>}
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
      <div className="mp-panel-links">
        {shopper && <Link href={href("/account")}>{t("My account", "আমার অ্যাকাউন্ট")}</Link>}
        <Link href={href("/help")}>{t("Help with orders", "অর্ডারের জন্য সহায়তা")}</Link>
      </div>
    </div>
  );
}
