import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { SignInGate } from "@/components/marketplace/session";
import { OrderTrackingView } from "@/components/order-tracking-view";
import { Breadcrumbs } from "@/components/store-ui";
import { orderTrackingDisplayPreferences } from "@/lib/commerce/order-tracking-display";
import { getShopper } from "@/lib/marketplace/auth";
import { marketplaceMode } from "@/lib/release-config";

export const metadata: Metadata = { title: "Track order", robots: { index: false, follow: false } };
const orderId = z.uuid();

export default async function AccountOrderTrackingPage({ params }: { params: Promise<{ id: string }> }) {
  if (!marketplaceMode()) notFound();
  const [{ id }, shopper, preferences] = await Promise.all([params, getShopper(), orderTrackingDisplayPreferences()]);
  return <div className="shell inner-page commerce-page">
    <Breadcrumbs items={[{ label: "Orders", href: "/orders" }, { label: "Track order" }]} />
    <div className="commerce-intro"><h1 className="display-type">Track order</h1></div>
    {!shopper ? <section className="commerce-panel">
      <h2>Sign in to track an order</h2>
      <SignInGate>Sign in to the account that owns this order.</SignInGate>
    </section> : orderId.safeParse(id).success ? <OrderTrackingView key={id} orderId={id} access="account" {...preferences} />
      : <section className="commerce-panel"><h2>Tracking unavailable</h2><p>We couldn’t open tracking for this order. Check your orders or contact support.</p></section>}
  </div>;
}
