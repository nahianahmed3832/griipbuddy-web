import type { Metadata } from "next";
import { z } from "zod";
import { OrderTrackingLink } from "@/components/order-tracking-link";
import { OrderTrackingView } from "@/components/order-tracking-view";
import { store } from "@/config/store";
import { orderTrackingDisplayPreferences } from "@/lib/commerce/order-tracking-display";

export const metadata: Metadata = { title: "Track your order", robots: { index: false, follow: false } };

const orderId = z.uuid();

export default async function GuestOrderTrackingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <div className="shell inner-page commerce-page customer-info">
    <div className="commerce-intro">
      <h1 className="display-type">Track your order</h1>
      <p><OrderTrackingLink className="text-link" href="/orders/track">Back to guest orders</OrderTrackingLink></p>
    </div>
    {orderId.safeParse(id).success
      ? <OrderTrackingView key={id} orderId={id} access="guest" {...await orderTrackingDisplayPreferences()} />
      : <section className="commerce-panel">
        <h2>Tracking is unavailable for this order</h2>
        <p>Use the browser you checked out with or open the order from your account. If you need help verifying the order, <a href={`mailto:${store.supportEmail}`}>contact GriipBuddy support</a>.</p>
      </section>}
  </div>;
}
