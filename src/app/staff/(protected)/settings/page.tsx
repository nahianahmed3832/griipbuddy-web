import Link from "next/link";
import { notFound } from "next/navigation";
import { pauseMarketAction, saveDeliveryAction, saveMarketAction } from "@/app/staff/settings-actions";
import { StaffActionForm } from "@/components/staff-actions";
import { getMarket, marketList, type Market } from "@/config/markets";
import { requireStaff } from "@/lib/staff/access";
import { getMarketSettings } from "@/lib/staff/market-settings";
import type { DeliveryZone } from "@/generated/prisma/client";
import { firstPartyStoreMode, orderIntakeOpen, productionMode } from "@/lib/release-config";
import { bangladeshCheckoutEnabled, usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";
import { paypalCheckoutAvailability } from "@/lib/commerce/paypal-config";

export const metadata = { title: "Market settings" };
const decimal = (minor?: number | null) => minor == null ? "" : (minor / 100).toFixed(2);

function DeliveryForm({ market, zone }: { market: Market; zone?: DeliveryZone }) {
  const existing = zone ? { district: zone.district, method: zone.method, revision: zone.revision } : null;
  return (
    <details className="commerce-panel">
      <summary>{zone ? `${zone.districtLabel} · ${zone.label} · ${zone.enabled ? "Enabled" : "Disabled"}` : "Add delivery option"}</summary>
      <StaffActionForm key={zone?.revision ?? "new"} action={saveDeliveryAction.bind(null, market.id, existing)} submitLabel="Save delivery option">
        <div className="commerce-fields">
          <label>District code<input name="district" defaultValue={zone?.district} readOnly={Boolean(zone)} required pattern="[a-z][a-z\\-]{1,39}" placeholder="dhaka" /></label>
          <label>District label<input name="districtLabel" defaultValue={zone?.districtLabel} maxLength={80} required /></label>
          <label>Method code<input name="method" defaultValue={zone?.method} readOnly={Boolean(zone)} required pattern="[a-z][a-z0-9\\-]{1,39}" placeholder="standard" /></label>
          <label>Method label<input name="label" defaultValue={zone?.label} maxLength={100} required /></label>
        </div>
        <label>Shipping charge ({market.currency})<input name="charge" inputMode="decimal" defaultValue={decimal(zone?.chargeMinor)} placeholder="Unconfigured" /></label>
        <label>Delivery guidance<textarea name="guidance" rows={3} maxLength={500} defaultValue={zone?.guidance ?? ""} /></label>
        <label className="commerce-option"><input name="enabled" type="checkbox" defaultChecked={zone?.enabled} /> Enable this delivery option</label>
        <label className="commerce-option"><input name="cod" type="checkbox" defaultChecked={zone?.codEligible ?? true} /> Eligible for cash on delivery</label>
      </StaffActionForm>
    </details>
  );
}

export default async function MarketSettingsPage({ searchParams }: { searchParams: Promise<{ market?: string }> }) {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const market = getMarket((await searchParams).market);
  if (market.id === "bd" && usesBangladeshCheckout()) return <>
    <div className="commerce-intro"><h1 className="display-type">Market settings</h1><p>Bangladesh · BD · BDT</p></div>
    <section className="commerce-panel">
      <h2>Bangladesh checkout</h2>
      <p>{bangladeshCheckoutEnabled() ? "Cash on delivery is available through griipbuddy.com." : "Bangladesh checkout is paused."}</p>
      <p>Manage delivery charges, payments and fulfillment in the existing GriipBuddy admin.</p>
      <a className="text-link" href="https://admin.griipbuddy.com/">Open GriipBuddy admin</a>
    </section>
  </>;
  const policy = await getMarketSettings(staff.id, market.id);
  const zones = policy?.deliveryZones ?? [];
  const hasDelivery = zones.some((zone) => zone.enabled && zone.codEligible && zone.chargeMinor !== null);
  const hasTax = policy?.taxBasisPoints != null && Boolean(policy.taxLabel);
  const intake = orderIntakeOpen();
  const checkoutOpen = intake && market.id === "bd" && policy?.enabled && policy.codEnabled && hasTax && hasDelivery;
  const usPreview = market.id === "us" && firstPartyStoreMode() ? paypalCheckoutAvailability() : null;
  return (
    <>
      <div className="commerce-intro">
        <h1 className="display-type">Market settings</h1>
        <p>{market.name} · {market.countryCode} · {market.currency}</p>
      </div>
      <nav className="staff-filters" aria-label="Markets">
        {marketList.map(({ id, name }) => <Link href={`/staff/settings?market=${id}`} aria-current={market.id === id ? "page" : undefined} key={id}>{name}</Link>)}
      </nav>
      {usPreview ? <section className="commerce-panel">
        <h2>US checkout preview</h2>
        <dl className="specifications">
          <div><dt>USD quotes</dt><dd>{usPreview.quoteEnabled ? "Open for testing" : "Paused"}</dd></div>
          <div><dt>PayPal sandbox</dt><dd>{usPreview.paymentEnabled ? "Available" : "Unavailable"}</dd></div>
        </dl>
        <p className="commerce-muted">Test shipping and PayPal sandbox settings come from the dev deployment.</p>
      </section> : <div className="commerce-layout">
        <section className="commerce-panel">
          <h2>Checkout and tax</h2>
          <p>{market.id === "us" ? "Browsing only in this release." : checkoutOpen ? productionMode() ? "COD checkout is open." : "Test COD checkout is open." : "Checkout is closed."}</p>
          {!intake && market.id === "bd" && <p className="commerce-message">Production order intake is closed.</p>}
          {!hasDelivery && <p className="commerce-message">No enabled delivery option with a configured shipping charge and COD eligibility.</p>}
          {!hasTax && <p className="commerce-message">Tax is unconfigured.</p>}
          <StaffActionForm key={policy?.revision ?? "new"} action={saveMarketAction.bind(null, market.id, policy?.revision ?? null)} submitLabel="Save market settings">
            <label className="commerce-option"><input type="checkbox" name="enabled" defaultChecked={market.id === "bd" && intake && policy?.enabled} disabled={market.id !== "bd" || !intake} /> Enable checkout</label>
            <label className="commerce-option"><input type="checkbox" name="cod" defaultChecked={policy?.codEnabled} /> Cash on delivery</label>
            <p className="commerce-muted">Online payment is unavailable.</p>
            <label>Tax on net merchandise (%)<input name="tax" inputMode="decimal" defaultValue={decimal(policy?.taxBasisPoints)} placeholder="Unconfigured" /></label>
            <label>Tax label<input name="taxLabel" maxLength={80} defaultValue={policy?.taxLabel ?? ""} /></label>
          </StaffActionForm>
          {policy?.enabled && market.id === "bd" && (
            <StaffActionForm action={pauseMarketAction.bind(null, market.id)} submitLabel="Pause new orders" secondary />
          )}
        </section>
        <section className="commerce-stack" aria-labelledby="delivery-options">
          <h2 id="delivery-options">Delivery options</h2>
          {zones.map((zone) => <DeliveryForm key={`${market.id}/${zone.district}/${zone.method}`} market={market} zone={zone} />)}
          <DeliveryForm key={market.id} market={market} />
        </section>
      </div>}
    </>
  );
}
