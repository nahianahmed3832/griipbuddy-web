import Link from "next/link";
import { notFound } from "next/navigation";
import { pauseMarketAction, saveDeliveryAction, saveMarketAction } from "@/app/staff/settings-actions";
import { StaffActionForm } from "@/components/staff-actions";
import type { Market } from "@/config/markets";
import { requireStaff } from "@/lib/staff/access";
import { getMarketSettings } from "@/lib/staff/market-settings";
import type { DeliveryZone } from "@/generated/prisma/client";
import { orderIntakeOpen, productionMode } from "@/lib/release-config";
import { paypalCheckoutAvailability } from "@/lib/commerce/paypal-config";
import { prepaidAvailable } from "@/lib/commerce/prepaid-config";
import { marketConfiguration, marketPayment, selectableMarkets, selectedMarketId } from "@/lib/market-config";
import { store } from "@/config/store";
import { catalogCopyFixture } from "@/lib/intelligence/catalog-copy-suggestions";

export const metadata = { title: "Market settings" };
const decimal = (minor?: number | null) => minor == null ? "" : (minor / 100).toFixed(2);

function DeliveryForm({ market, zone }: { market: Market; zone?: DeliveryZone }) {
  const existing = zone ? { district: zone.district, method: zone.method, revision: zone.revision } : null;
  return (
    <details className="commerce-panel">
      <summary>{zone ? `${zone.districtLabel} · ${zone.label} · ${zone.enabled ? "Enabled" : "Disabled"}` : "Add delivery option"}</summary>
      <StaffActionForm key={zone?.revision ?? "new"} action={saveDeliveryAction.bind(null, market.id, existing)} submitLabel="Save delivery option">
        <div className="commerce-fields">
          <label>Delivery area code<input name="district" defaultValue={zone?.district} readOnly={Boolean(zone)} required pattern="[a-z][a-z\\-]{1,39}" /></label>
          <label>Delivery area name<input name="districtLabel" defaultValue={zone?.districtLabel} maxLength={80} required /></label>
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
  const market = marketConfiguration(selectedMarketId((await searchParams).market));
  const policy = await getMarketSettings(staff.id, market.id);
  const zones = policy?.deliveryZones ?? [];
  const hasTax = policy?.taxBasisPoints != null && Boolean(policy.taxLabel);
  const intake = orderIntakeOpen();
  const evidence = productionMode() ? "production" : "sandbox";
  const cod = Boolean(marketPayment(market, "COD", evidence));
  const prepaid = prepaidAvailable(market.id);
  const hasDelivery = zones.some(zone => zone.enabled && (!policy?.codEnabled || zone.codEligible) && zone.chargeMinor !== null);
  const nativePolicy = market.checkoutAuthority === "native" && market.delivery.coverage === "checkout-policy" && market.pricing.taxTreatment === "MERCHANDISE_RATE";
  const saveEnabled = nativePolicy && intake && (cod || prepaid);
  const checkoutOpen = saveEnabled && policy?.enabled && (cod && policy.codEnabled || prepaid) && hasTax && hasDelivery;
  const paypal = marketPayment(market, "PAYPAL", evidence) ? paypalCheckoutAvailability(market.id) : null;
  return (
    <>
      <div className="commerce-intro">
        <h1 className="display-type">Market settings</h1>
        <p>{market.name} · {market.countryCode} · {market.currency} · {market.status}</p>
      </div>
      <nav className="staff-filters" aria-label="Markets">
        {selectableMarkets().map(({ id, name }) => <Link href={`/staff/settings?market=${id}`} aria-current={market.id === id ? "page" : undefined} key={id}>{name}</Link>)}
      </nav>
      <section className="commerce-panel" aria-labelledby="business-profile">
        <h2 id="business-profile">Business profile</h2>
        <dl className="specifications">
          <div><dt>Store</dt><dd>{store.name}</dd></div>
          <div><dt>Customer contact</dt><dd><a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a></dd></div>
          <div><dt>Reporting time zone</dt><dd>{market.timeZone}</dd></div>
          <div><dt>Checkout authority</dt><dd>{market.checkoutAuthority === "native" ? "Native checkout" : "Regional checkout service"}</dd></div>
          <div><dt>Catalog copy</dt><dd>{catalogCopyFixture() ? "Simulated provider" : "Provider unavailable"}</dd></div>
        </dl>
      </section>
      {market.checkoutAuthority === "legacy-handoff" ? <section className="commerce-panel">
        <h2>Legacy checkout provider</h2>
        <p>Delivery charges, payments and fulfillment are managed by the configured checkout authority.</p>
      </section> : paypal ? <section className="commerce-panel">
        <h2>Sandbox checkout</h2>
        <dl className="specifications">
          <div><dt>{market.currency} quotes</dt><dd>{paypal.quoteEnabled ? "Open for testing" : "Paused"}</dd></div>
          <div><dt>PayPal sandbox</dt><dd>{paypal.paymentEnabled ? "Available" : "Unavailable"}</dd></div>
        </dl>
        <p className="commerce-muted">Test shipping and PayPal sandbox settings come from the dev deployment.</p>
      </section> : <div className="commerce-layout">
        <section className="commerce-panel">
          <h2>Checkout and tax</h2>
          <p>{checkoutOpen ? productionMode() ? "Checkout is open." : "Test checkout is open." : "Checkout is closed."}</p>
          {!intake && <p className="commerce-message">Order intake is closed.</p>}
          {!hasDelivery && <p className="commerce-message">A compatible delivery option and shipping charge are required.</p>}
          {!hasTax && <p className="commerce-message">Tax is unconfigured.</p>}
          <StaffActionForm key={policy?.revision ?? "new"} action={saveMarketAction.bind(null, market.id, policy?.revision ?? null)} submitLabel="Save market settings">
            <label className="commerce-option"><input type="checkbox" name="enabled" defaultChecked={saveEnabled && policy?.enabled} disabled={!saveEnabled} /> Enable checkout</label>
            <label className="commerce-option"><input type="checkbox" name="cod" defaultChecked={cod && policy?.codEnabled} disabled={!cod} /> Cash on delivery</label>
            <p className="commerce-muted">{prepaid ? "Online payment sandbox is configured." : "Online payment is unavailable."}</p>
            <label>Tax on net merchandise (%)<input name="tax" inputMode="decimal" defaultValue={decimal(policy?.taxBasisPoints)} placeholder="Unconfigured" /></label>
            <label>Tax label<input name="taxLabel" maxLength={80} defaultValue={policy?.taxLabel ?? ""} /></label>
          </StaffActionForm>
          {policy?.enabled && (
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
