import { cookies } from "next/headers";
import Link from "next/link";
import { OrderTrackingLink } from "@/components/order-tracking-link";
import { store } from "@/config/store";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { parcelOrderLabel, type OrderParcelTracking } from "@/lib/commerce/parcel-tracking";
import { fulfillmentLabels, orderLabels } from "@/lib/commerce/labels";
import { integratedCheckout, listRecoveredOrders } from "@/lib/commerce/integrated-checkout";
import { bangladeshTrackingUrl, usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { shopperOrders } from "@/lib/marketplace/data";

export const metadata = { title: "Order status", robots: { index: false, follow: false } };

type OrderListEntry = {
  id: string;
  reference: string;
  status: keyof typeof orderLabels;
  fulfillmentStatus: keyof typeof fulfillmentLabels;
  createdAt: Date;
  shopperId?: string | null;
  bangladeshShipment?: { status: keyof typeof bangladeshTrackingLabels } | null;
  bangladeshRefusedParcelReceipt?: { receivedAt: Date } | null;
  parcels?: Pick<OrderParcelTracking, "status">[];
};

export default async function CustomerOrdersPage() {
  const guestKey = readGuestKey((await cookies()).get(guestCookie)?.value);
  const marketplace = marketplaceMode();
  const shopper = marketplace ? await getShopper() : null;
  const recovered = !marketplace && integratedCheckout();
  const orders: OrderListEntry[] = recovered && guestKey ? await listRecoveredOrders(guestKey)
    : shopper || guestKey ? await shopperOrders(shopper?.id, guestKey) : [];
  return (
    <div className="shell inner-page commerce-page customer-info">
      <div className="commerce-intro">
        <h1 className="display-type">{marketplace ? "Purchases and reviews" : "Order status"}</h1>
        {usesBangladeshCheckout()
          ? <p><a className="text-link" href={bangladeshTrackingUrl}>Track a Bangladesh order on griipbuddy.com</a></p>
          : <p>{shopper ? "Open an order to see its delivery status or get help." : "Open a recent order in the browser you used for checkout."}</p>}
      </div>
      {orders.length === 0 ? <section className="commerce-panel">
        <h2>{shopper ? "No purchases yet" : "No orders in this browser"}</h2>
        <p>If you need help finding an order, email <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a> with your order reference.</p>
      </section> : <ul className="staff-orders">
        {orders.map((order) => <li className="staff-order-row commerce-panel" key={order.id}>
          <div>
            <Link className="staff-order-ref" href={`/orders/${order.id}`}>{order.reference}</Link>
            {!recovered && <p><OrderTrackingLink className="text-link" href={order.shopperId ? `/orders/${order.id}/tracking` : `/orders/track/${order.id}`}>Track order</OrderTrackingLink></p>}
          </div>
          <span>{order.status === "CANCELLED" ? orderLabels.CANCELLED
            : order.parcels?.length ? parcelOrderLabel(order.parcels)
            : order.bangladeshRefusedParcelReceipt ? "Returned to GriipBuddy"
            : order.bangladeshShipment ? bangladeshTrackingLabels[order.bangladeshShipment.status]
            : fulfillmentLabels[order.fulfillmentStatus]}</span>
          <time dateTime={order.createdAt.toISOString()}>{order.createdAt.toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" })}</time>
        </li>)}
      </ul>}
    </div>
  );
}
