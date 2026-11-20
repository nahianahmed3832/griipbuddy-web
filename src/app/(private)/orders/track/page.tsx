import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { OrderTrackingLink } from "@/components/order-tracking-link";
import { store } from "@/config/store";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { integratedCheckout, listRecoveredOrders } from "@/lib/commerce/integrated-checkout";
import { reportFailure } from "@/lib/db/observability";
import { shopperOrders } from "@/lib/marketplace/data";

export const metadata: Metadata = { title: "Track your order", robots: { index: false, follow: false } };

async function GuestOrders() {
  const checkoutProof = (await cookies()).get(guestCookie)?.value;
  let orders: { id: string; reference: string }[];
  try {
    const guestKey = readGuestKey(checkoutProof);
    if (guestKey) {
      const [native, recovered] = await Promise.all([
        shopperOrders(undefined, guestKey),
        integratedCheckout("bd") ? listRecoveredOrders(guestKey).catch(error => {
          reportFailure("guest-tracking.recovered-list", undefined, error);
          return [];
        }) : [],
      ]);
      orders = [...native, ...recovered].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 40);
    } else orders = [];
  } catch (error) {
    reportFailure("guest-tracking.orders", undefined, error);
    return <section className="commerce-panel">
      <h2>Tracking is temporarily unavailable</h2>
      <p>We couldn’t check for orders in this browser.</p>
      <form method="get"><button className="button button--outline" type="submit">Try again</button></form>
    </section>;
  }

  if (orders.length) return <section className="commerce-panel" aria-labelledby="verified-orders">
    <h2 id="verified-orders">Orders verified in this browser</h2>
    <ul className="commerce-stack">
      {orders.map(({ id, reference }) => <li key={id}>
        <OrderTrackingLink className="text-link" href={`/orders/track/${id}`}>Track order {reference}</OrderTrackingLink>
      </li>)}
    </ul>
  </section>;

  return <section className="commerce-panel">
    <h2>No orders verified in this browser</h2>
    <p>Open this page in the browser you used at checkout. If that access has expired or you saved the order to your account, use your account orders or contact support to verify the purchase.</p>
  </section>;
}

export default function GuestTrackingPage() {
  return <div className="shell inner-page commerce-page customer-info">
    <div className="commerce-intro">
      <h1 className="display-type">Track your order</h1>
      <p>Find delivery updates for a guest order using the browser you checked out with.</p>
    </div>
    <div className="commerce-stack">
      <Suspense fallback={<p className="commerce-panel" role="status">Checking this browser for guest orders…</p>}>
        <GuestOrders />
      </Suspense>
      <section className="commerce-panel">
        <h2>Need help finding an order?</h2>
        <p><Link className="text-link" href="/orders" prefetch={false}>View your account orders</Link> or <a href={`mailto:${store.supportEmail}`}>contact GriipBuddy support</a>.</p>
      </section>
    </div>
  </div>;
}
