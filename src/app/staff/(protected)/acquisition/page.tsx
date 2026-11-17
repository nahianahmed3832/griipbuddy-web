import Link from "next/link";
import { storefrontPath } from "@/config/storefront-path";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/staff/access";
import { acquisitionReport } from "@/lib/measurement/report";
import { acquisitionCampaign } from "@/lib/measurement/campaign";
import { measurementEnabled } from "@/lib/measurement/server";
import { bangladeshCheckoutEnabled } from "@/lib/commerce/bangladesh-handoff";
import "./acquisition.css";

export const metadata = { title: "Acquisition", robots: { index: false, follow: false } };

const clock = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Dhaka" });
const units = (amount: bigint, currency: string) => {
  const fraction = String(amount % 100n).padStart(2, "0");
  return `${currency} ${(amount / 100n).toLocaleString("en-GB")}.${fraction}`;
};
function rate(numerator: number, denominator: number) {
  return denominator === 0 ? "—" : `${(numerator * 100 / denominator).toFixed(1)}%`;
}

const orders = (count: number) => `${count} ${count === 1 ? "order" : "orders"}`;

const names: Record<string, string> = {
  PRODUCT_VIEW: "Product viewed", CART_ADD: "Added to cart", CHECKOUT_START: "Checkout started",
  ORDER_ACCEPTED: "Order accepted", ORDER_CANCELLED: "Order cancelled", COD_COLLECTED: "COD reported collected",
};

export default async function AcquisitionPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const params = await searchParams;
  const test = params.scope === "test";
  const marketId = params.market === "us" ? "us" : "bd";
  const report = await acquisitionReport({
    test, marketId, from: typeof params.from === "string" ? params.from : undefined,
    to: typeof params.to === "string" ? params.to : undefined,
  }).catch(() => null);
  const path = (view: string) => `/staff/acquisition?scope=${test ? "test" : "live"}&market=${marketId}&view=${view}${report ?
    `&from=${report.window.from}&to=${report.window.to}` : ""}`;
  const debug = params.view === "events";
  return <div className="acquisition">
    <div className="commerce-intro">
      <p className="eyebrow">Owner reporting</p>
      <h1 className="display-type">Acquisition</h1>
      <p>Follow consenting shoppers from the first measured product view through the saved order.</p>
    </div>
    <nav aria-label="Acquisition views" className="commerce-fields">
      <Link className={`button button--${debug ? "outline" : "primary"}`} aria-current={!debug ? "page" : undefined} href={path("report")}>Funnel report</Link>
      <Link className={`button button--${debug ? "primary" : "outline"}`} aria-current={debug ? "page" : undefined} href={path("events")}>Event debugging</Link>
    </nav>
    <section className="commerce-panel commerce-stack">
      <h2>{test ? "Test records only" : "Live records only"}</h2>
      {test && <p>This view contains synthetic activity. Ordinary results always exclude it.</p>}
      {!measurementEnabled() && <p>Shopping measurement is turned off for this environment.</p>}
      <form action={storefrontPath("/staff/acquisition")} className="commerce-form">
        <input type="hidden" name="view" value={debug ? "events" : "report"} />
        <div className="commerce-fields">
          <label>Dataset<select name="scope" defaultValue={test ? "test" : "live"}><option value="live">Live only</option><option value="test">Test only</option></select></label>
          <label>Market<select name="market" defaultValue={marketId}><option value="bd">Bangladesh</option><option value="us">United States</option></select></label>
        </div>
        <div className="commerce-fields">
          <label>First visit from<input name="from" type="date" defaultValue={report?.window.from} /></label>
          <label>Through (inclusive)<input name="to" type="date" defaultValue={report?.window.to} /></label>
        </div>
        <button className="button button--outline" type="submit">Update report</button>
      </form>
      <p className="commerce-muted">Choose up to seven calendar days from the last 30 days, in Asia/Dhaka.</p>
    </section>
    {report?.kind === "report" ? debug ? <>
      <section className="commerce-panel commerce-stack">
        <h2>Recent events</h2>
        <p>Last 60 observations and matched business outcomes. The references identify events, not customers. Times are in Asia/Dhaka.</p>
        {!report.debug.length ? <p>No events for this window and dataset.</p> :
          <div className="acquisition-table" role="region" aria-label="Recent events table" tabIndex={0}><table>
            <thead><tr><th>Time</th><th>Event</th><th>Event reference</th><th>Variant / units</th><th>Campaign</th><th>Amount</th></tr></thead>
            <tbody>{report.debug.map(row => <tr key={row.id}>
              <td>{clock.format(row.at)}</td><td>{names[row.kind]}</td><td><code>{row.id.slice(0, 12)}</code></td>
              <td>{row.variantId ?? "—"}{row.quantity != null && ` / ${row.quantity}`}</td><td>{row.campaign ?? "Unknown"}</td>
              <td>{row.amountMinor != null && row.currency ? units(BigInt(row.amountMinor), row.currency) : "—"}</td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      {report.sampleOrder && <section className="commerce-panel commerce-stack">
        <h2>GA4 payload preview</h2>
        <p>Matched test order. This is a schema preview only. No request was sent.</p>
        <pre className="acquisition-payload" tabIndex={0}>{JSON.stringify(report.sampleOrder, null, 2)}</pre>
      </section>}
    </> : <>
      <section className="commerce-panel commerce-stack">
        <h2>Funnel</h2>
        <p>{report.window.from} to {report.window.to}, Asia/Dhaka. One journey per consenting browser identifier and market; each starts at the first observed product view. Steps must occur in order within seven days.</p>
        <div className="acquisition-table" role="region" aria-label="Funnel table" tabIndex={0}><table>
          <thead><tr><th>Stage</th><th>Journeys</th><th>Share of measured product journeys</th></tr></thead>
          <tbody>
            <tr><td>Observed product visits</td><td>{report.funnel.product}</td><td>{rate(report.funnel.product, report.funnel.product)}</td></tr>
            <tr><td>Added to cart</td><td>{report.funnel.cart}</td><td>{rate(report.funnel.cart, report.funnel.product)}</td></tr>
            <tr><td>Started checkout</td><td>{report.funnel.checkout}</td><td>{rate(report.funnel.checkout, report.funnel.product)}</td></tr>
            <tr><td>Matched to an accepted order</td><td>{report.funnel.accepted}</td><td>{rate(report.funnel.accepted, report.funnel.product)}</td></tr>
          </tbody>
        </table></div>
        <p>Store orders in the same calendar period: {report.orderPeriodTotal}. Unmatched: {report.unmatched}. Matched to an earlier visit outside this cohort: {report.matchedOutsideCohort}. Historical records with unknown test status excluded: {report.unclassified}.</p>
        <p>Refreshed {clock.format(report.now)}. Latest eligible observation: {report.latestObservation ? clock.format(report.latestObservation) : "none"}. Recent journeys can still convert; order outcomes may continue to change.</p>
      </section>
      <section className="commerce-panel commerce-stack">
        <h2>Attribution</h2>
        <p>The first measured product view receives credit when its exact campaign tags are recognized. A later click does not change credit. Untagged or unrecognized visits stay Unknown.</p>
        <div className="acquisition-table" role="region" aria-label="Attribution table" tabIndex={0}><table>
          <thead><tr><th>Source</th><th>Product journeys</th><th>Cart</th><th>Checkout</th><th>Accepted orders</th><th>Orders with promoted item</th></tr></thead>
          <tbody>{[acquisitionCampaign.label, null].map(label => {
            const metrics = report.sources.get(label);
            return <tr key={label ?? "unknown"}><td>{label ?? "Unknown"}</td><td>{metrics?.product ?? 0}</td><td>{metrics?.cart ?? 0}</td>
              <td>{metrics?.checkout ?? 0}</td><td>{metrics?.orders ?? 0}</td><td>{metrics?.promotedOrders ?? 0}</td></tr>;
          })}</tbody>
        </table></div>
      </section>
      <section className="commerce-panel commerce-stack">
        <h2>Matched order outcomes</h2>
        <p>{orders(report.matched)} accepted, {report.cancelled} cancelled, {report.shipped} in transit, {report.delivered} delivered, {report.awaitingCod} awaiting COD collection. A journey can contain more than one order.</p>
        {[...report.currencies].map(([currency, value]) => <p key={currency}>
          {units(value.booked, currency)} booked on {orders(value.acceptedOrders)}. {units(value.collected, currency)} COD reported collected on {orders(value.collectionOrders)}.
        </p>)}
        <p>Online captures, failed delivery, settlement and refunds: unavailable for this checkout source. COD booked value does not indicate money received.</p>
      </section>
    </> : <p className="state-panel" role="status">{report ? "This window exceeds the report limit. Choose a shorter date range." : "The acquisition report is unavailable. Try again shortly."}</p>}
    <section className="commerce-panel commerce-stack">
      <h2>Measurement coverage</h2>
      <p>{bangladeshCheckoutEnabled()
        ? "Bangladesh checkout continues on the legacy store. Its orders and payment outcomes are not connected to this report."
        : "This report reads the managed storefront’s order records. Activity and orders on the live legacy checkout are outside its coverage."}</p>
      <p>Visitors without consent and journeys across browsers are not measured. This storefront uses saved orders and staff collection evidence. Time to delivery and collection varies.</p>
      <p>GA4 and Meta delivery are disabled. Campaign spend and platform-attributed conversions: not connected to this report. No return on ad spend is calculated.</p>
    </section>
  </div>;
}
