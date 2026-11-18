import Link from "next/link";
import { notFound } from "next/navigation";
import { historicalKind, historicalState, LegacyOrderSummary } from "@/components/marketplace/legacy-order";
import { OrderDocumentLink } from "@/components/marketplace/order-document-link";
import { SignInGate } from "@/components/marketplace/session";
import { store } from "@/config/store";
import { customerOrderDate } from "@/lib/commerce/account-order";
import { currentMarket } from "@/lib/market-server";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { bdLegacyAccess } from "@/lib/marketplace/bd-order-hub";
import { bdOrderHubConfig, legacyId, legacyKind, legacyOrderDetail, OrderHubBridgeError } from "@/lib/marketplace/bd-order-hub-bridge";
import { reportFailure } from "@/lib/db/observability";
import "../../../order-history.css";

export const metadata = { title: "Bangladesh order details", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function HistoricalOrderPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  if (!bdOrderHubConfig() || (await currentMarket()).id !== "bd") notFound();
  const [path, shopper, language] = await Promise.all([params, getShopper(), currentAccountLanguage("bd")]);
  const kind = legacyKind.safeParse(path.kind);
  const id = legacyId.safeParse(path.id);
  if (!kind.success || !id.success) notFound();
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const back = <Link href="/bd/orders">{t("Back to My Orders", "আমার অর্ডারে ফিরে যান")}</Link>;
  if (!shopper) return <div className="shell inner-page commerce-page" lang={language}>
    <SignInGate language={language}>{t("Sign in to view this order.", "এই অর্ডার দেখতে সাইন ইন করুন।")}</SignInGate>
    {back}
  </div>;
  const access = await bdLegacyAccess(shopper.id);
  if (!access.legacyCustomerId && !access.grants.some(grant => grant.kind === kind.data && grant.id === id.data)) notFound();
  let order;
  try {
    order = await legacyOrderDetail(access, kind.data, id.data);
  } catch (error) {
    if (error instanceof OrderHubBridgeError && error.status === 404) notFound();
    reportFailure("bd-order-hub.detail", undefined, error);
    return <div className="shell inner-page commerce-page" lang={language}>
      <p role="status">{t("This order is temporarily unavailable. Try again shortly.", "এই অর্ডার সাময়িকভাবে দেখা যাচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন।")}</p>
      {back}
    </div>;
  }
  const count = new Intl.NumberFormat(language === "bn" ? "bn-BD" : "en-BD");
  return <div className="shell inner-page commerce-page commerce-stack" lang={language}>
    <div className="commerce-intro">
      {back}
      <h1 className="display-type">{historicalKind(order, language)} {order.reference}</h1>
      <time dateTime={order.createdAt}>{customerOrderDate(new Date(order.createdAt), "bd", language)}</time>
      <div className="order-detail-actions"><OrderDocumentLink orderPath={`/orders/history/${order.kind}/${order.id}`}
        reference={order.reference} market="bd" kind="order-summary" language={language} className="button button--outline" /></div>
    </div>
    <section className="commerce-panel commerce-summary">
      <h2>{t("Status and payment", "অবস্থা ও পেমেন্ট")}</h2>
      <LegacyOrderSummary order={order} language={language} />
      {order.trackingCode && <p>{t("Tracking reference", "ট্র্যাকিং নম্বর")} <strong>{order.trackingCode}</strong></p>}
    </section>
    {order.items.length > 0 && <section className="commerce-panel">
      <h2>{t("Items", "পণ্য")}</h2>
      <ul className="account-order-items">
        {order.items.map((item, index) => <li key={index}>{item.name} × {count.format(item.quantity)}{item.sku && ` · ${item.sku}`}</li>)}
      </ul>
    </section>}
    {order.history && order.history.length > 0 && <section className="commerce-panel">
      <h2>{t("Order activity", "অর্ডারের কার্যক্রম")}</h2>
      <ol className="staff-history">
        {order.history.map((event, index) => <li key={index}>
          <strong>{historicalState(event, language)}</strong>
          <time dateTime={event.createdAt}>{customerOrderDate(new Date(event.createdAt), "bd", language, true)}</time>
        </li>)}
      </ol>
    </section>}
    <section className="commerce-panel">
      <h2>{t("Help with this order", "এই অর্ডারে সহায়তা")}</h2>
      <p>{t("For changes, returns, exchanges or refunds on this earlier purchase, contact support with the order reference.",
        "আগের এই কেনাকাটা পরিবর্তন, ফেরত, বদল বা টাকা ফেরতের জন্য অর্ডার নম্বরসহ সহায়তা দলের সঙ্গে যোগাযোগ করুন।")}</p>
      <a href={`mailto:${store.supportEmail}?subject=${encodeURIComponent(`Order ${order.reference}`)}`}>{store.supportEmail}</a>
    </section>
  </div>;
}
