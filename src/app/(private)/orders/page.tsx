import { cookies } from "next/headers";
import Link from "next/link";
import { AccountPanel, AccountWorkspace } from "@/components/marketplace/account-workspace";
import { OrderTrackingLink } from "@/components/order-tracking-link";
import { formatMoney, markets, type Currency, type MarketId } from "@/config/markets";
import { store } from "@/config/store";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { parcelOrderLabel, type OrderParcelTracking } from "@/lib/commerce/parcel-tracking";
import { fulfillmentLabels, orderDate, orderLabels, paymentLabels } from "@/lib/commerce/labels";
import { integratedCheckout, listRecoveredOrders } from "@/lib/commerce/integrated-checkout";
import { bangladeshTrackingUrl, usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";
import { reportFailure } from "@/lib/db/observability";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { shopperOrders } from "@/lib/marketplace/data";
import { currentMarket } from "@/lib/market-server";

export const metadata = { title: "Order status", robots: { index: false, follow: false } };

type OrderListEntry = {
  id: string;
  reference: string;
  status: keyof typeof orderLabels;
  fulfillmentStatus: keyof typeof fulfillmentLabels;
  createdAt: Date;
  shopperId?: string | null;
  marketId: MarketId;
  currency?: Currency;
  totalMinor?: number;
  payment?: { status: keyof typeof paymentLabels } | null;
  bangladeshShipment?: { status: keyof typeof bangladeshTrackingLabels } | null;
  bangladeshRefusedParcelReceipt?: { receivedAt: Date } | null;
  parcels?: Pick<OrderParcelTracking, "status">[];
};

export default async function CustomerOrdersPage() {
  const guestKey = readGuestKey((await cookies()).get(guestCookie)?.value);
  const marketplace = marketplaceMode();
  const shopper = marketplace ? await getShopper() : null;
  const [native, recovered] = await Promise.all([
    shopper || guestKey ? shopperOrders(shopper?.id, guestKey) : [],
    integratedCheckout() ? listRecoveredOrders(guestKey, shopper?.id).catch(error => {
      reportFailure("orders.recovered-list", undefined, error);
      return [];
    }) : [],
  ]);
  const orders: OrderListEntry[] = [...native, ...recovered.map(order => ({ ...order, marketId: "bd" as const }))]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 40);
  const title = marketplace ? "Purchases and reviews" : "Order status";
  const introduction = usesBangladeshCheckout()
    ? <p><a className="text-link" href={bangladeshTrackingUrl}>Track a Bangladesh order on griipbuddy.com</a></p>
    : <p>{shopper ? "Open an order to see its delivery status or get help." : "Open a recent order in the browser you used for checkout."}</p>;
  const history = orders.length === 0 ? <section className="commerce-panel">
    <h2>{shopper ? "No purchases yet" : "No orders in this browser"}</h2>
    <p>If you need help finding an order, email <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a> with your order reference.</p>
    {shopper && <Link className="button button--outline" href="/shop">Browse products</Link>}
  </section> : <ul className="staff-orders">
    {orders.map(order => <li className="staff-order-row commerce-panel" key={order.id}>
      <div>
        <Link className="staff-order-ref" href={`/orders/${order.id}`}>{order.reference}</Link>
        <p>{markets[order.marketId].name}{order.totalMinor !== undefined &&
          ` · ${formatMoney(order.totalMinor, { ...markets[order.marketId], currency: order.currency ?? markets[order.marketId].currency })}`}</p>
        <OrderTrackingLink className="text-link" href={order.shopperId ? `/orders/${order.id}/tracking` : `/orders/track/${order.id}`}>Track order</OrderTrackingLink>
      </div>
      <div>
        <strong>{order.status === "CANCELLED" ? orderLabels.CANCELLED
          : order.parcels?.length ? parcelOrderLabel(order.parcels)
          : order.bangladeshRefusedParcelReceipt ? "Returned to GriipBuddy"
          : order.bangladeshShipment ? bangladeshTrackingLabels[order.bangladeshShipment.status]
          : fulfillmentLabels[order.fulfillmentStatus]}</strong>
        {order.payment && <p>{paymentLabels[order.payment.status]}</p>}
      </div>
      <time dateTime={order.createdAt.toISOString()}>{orderDate(order.createdAt, order.marketId)}</time>
    </li>)}
  </ul>;

  if (shopper) return <AccountWorkspace title={title} market={await currentMarket()} active="/orders">
    <AccountPanel title="Order history">
      <p>Your purchases keep their original market and currency.</p>{introduction}{history}
    </AccountPanel>
  </AccountWorkspace>;

  return <div className="shell inner-page commerce-page customer-info">
    <div className="commerce-intro"><h1 className="display-type">{title}</h1>{introduction}</div>
    {history}
  </div>;
}
