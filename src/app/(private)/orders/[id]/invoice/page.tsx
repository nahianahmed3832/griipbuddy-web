import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderBreakdown, PurchasedItems } from "@/components/order-summary";
import { PrintOrderDocument } from "@/components/staff-actions";
import { markets } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { orderLabels, paymentLabels, paymentMethodLabels } from "@/lib/commerce/labels";
import { guestOrder } from "@/lib/commerce/orders";
import { getShopper } from "@/lib/marketplace/auth";
import { marketplaceMode } from "@/lib/release-config";

export const metadata: Metadata = { title: "Order invoice", robots: { index: false, follow: false } };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, jar, shopper] = await Promise.all([params, cookies(), marketplaceMode() ? getShopper() : null]);
  const key = readGuestKey(jar.get(guestCookie)?.value);
  if (!key && !shopper) notFound();
  const order = await guestOrder(id, key, shopper?.id);
  if (!order?.payment) notFound();
  const market = { ...markets[order.marketId], currency: order.currency };
  const date = new Intl.DateTimeFormat(market.locale, { dateStyle: "long", timeZone: "UTC" }).format(order.createdAt);
  return <article className="shell inner-page commerce-page order-invoice">
    <div className="commerce-intro">
      <div className="order-invoice__controls screen-only">
        <Link className="text-link" href={`/orders/${order.id}`}>Back to your order</Link>
        <a className="button button--outline" href={storefrontPath(`/api/orders/${order.id}/invoice`)} download>Download invoice</a>
        <PrintOrderDocument label="Print invoice" />
      </div>
      <h1 className="display-type">GriipBuddy order invoice</h1>
      <p>Order {order.reference} · {date} · {order.currency}</p>
      <p>{orderLabels[order.status]} · {paymentMethodLabels[order.payment.method]} · {paymentLabels[order.payment.status]}</p>
    </div>
    <div className="commerce-layout">
      <div className="commerce-stack">
        <section className="commerce-panel">
          <h2>Purchased items</h2>
          <PurchasedItems lines={order.items} market={market} />
        </section>
        <section className="commerce-panel">
          <h2>Delivery address</h2>
          <address>{order.customerName}<br />{order.address}<br />
            {order.locality}, {order.districtLabel} {order.postalCode}</address>
        </section>
      </div>
      <OrderBreakdown totals={order} market={market} heading="Invoice totals" />
    </div>
  </article>;
}
