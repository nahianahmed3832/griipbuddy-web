import Link from "next/link";
import { isMarketId, marketList } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { marketConfiguration } from "@/lib/market-config";
import { acquisitionReport } from "@/lib/measurement/report";
import { acquisitionCampaign } from "@/lib/measurement/campaign";
import { measurementEnabled } from "@/lib/measurement/server";
import { configuredReportingFx, convertedTotal } from "@/lib/measurement/reporting-fx";
import { MarketSummary, money } from "./market-summary";
import "./acquisition.css";

export const metadata = { title: "Acquisition", robots: { index: false, follow: false } };

const units = (amount: bigint, currency: string) => {
  const format = marketList.find(option => option.currency === currency);
  return format ? money(amount, format) : `${amount} minor units (${currency})`;
};
function rate(numerator: number, denominator: number) {
  return denominator === 0 ? "—" : `${(numerator * 100 / denominator).toFixed(1)}%`;
}

const orders = (count: number) => `${count} ${count === 1 ? "order" : "orders"}`;

const names: Record<string, string> = {
  PRODUCT_IMPRESSION: "Product impression", HOMEPAGE_SECTION_IMPRESSION: "Homepage section impression", PRODUCT_CLICK: "Product clicked",
  CATEGORY_IMPRESSION: "Category impression", CATEGORY_CLICK: "Category clicked", CATEGORY_FILTER: "Category filters changed",
  PRODUCT_VIEW: "Product viewed", CART_ADD: "Added to cart", CHECKOUT_START: "Checkout started",
  SEARCH: "Search completed", SEARCH_FILTER: "Search filters changed", WISHLIST_ADD: "Added to wishlist", WISHLIST_REMOVE: "Removed from wishlist",
  CART_UPDATE: "Cart quantity updated", CART_REMOVE: "Removed from cart", CHECKOUT_STEP: "Checkout step", CHECKOUT_FAILURE: "Checkout failed",
  ACCOUNT_ASSOCIATED: "Consented account association",
  EXPERIMENT_EXPOSURE: "Visible experiment exposure",
  ORDER_ACCEPTED: "Order accepted", ORDER_CANCELLED: "Order cancelled", COD_COLLECTED: "COD reported collected",
  ORDER_DELIVERED: "Order delivered", ORDER_REFUSED: "Delivery refused", PAYMENT_PAID: "Online payment captured", PAYMENT_FAILED: "Payment failed",
  RETURN_REQUESTED: "Return requested", RETURN_RECEIVED: "Return received", ORDER_REFUNDED: "Order refunded", COD_REMITTED: "COD remittance matched",
};

export default async function AcquisitionPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireStaff();
  const allowed = await staffMarketIds(staff.id, "reporting");
  const params = await searchParams;
  if (!allowed.length || (params.market !== undefined && params.market !== "all" &&
      (!isMarketId(params.market) || !allowed.includes(params.market)))) notFound();
  const test = params.scope === "test";
  const from = typeof params.from === "string" ? params.from : undefined;
  const to = typeof params.to === "string" ? params.to : undefined;
  if (params.market === "all") {
    if (allowed.length < 2) notFound();
    return <CrossMarketReport ids={allowed} test={test} from={from} to={to} />;
  }
  const market = marketConfiguration(isMarketId(params.market) ? params.market : allowed[0]);
  const marketId = market.id;
  const clock = new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeStyle: "medium", timeZone: market.timeZone });
  const report = await acquisitionReport({ test, marketId, from, to }).catch(() => null);
  const path = (view: string) => `/staff/acquisition?scope=${test ? "test" : "live"}&market=${marketId}&view=${view}${report ?
    `&from=${report.window.from}&to=${report.window.to}` : ""}`;
  const debug = params.view === "events";
  return <div className="acquisition">
    <div className="commerce-intro">
      <p className="eyebrow">Market reporting</p>
      <h1 className="display-type">Acquisition</h1>
      <p>See how shoppers discover products, how often they place orders, and what happens after checkout in {market.name}.</p>
    </div>
    <nav aria-label="Acquisition views" className="commerce-fields">
      <Link className={`button button--${debug ? "outline" : "primary"}`} aria-current={!debug ? "page" : undefined} href={path("report")}>Market report</Link>
      <Link className={`button button--${debug ? "primary" : "outline"}`} aria-current={debug ? "page" : undefined} href={path("events")}>Event debugging</Link>
      <Link className="button button--outline" href={`/staff/acquisition/experiments?scope=${test ? "test" : "live"}&market=${marketId}`}>Experiments</Link>
    </nav>
    <section className="commerce-panel commerce-stack">
      <h2>{test ? "Test records only" : "Live records only"}</h2>
      {test && <p>This view contains synthetic activity. Ordinary results always exclude it.</p>}
      {!measurementEnabled() && <p>Shopping measurement is turned off for this environment.</p>}
      <form action={storefrontPath("/staff/acquisition")} className="commerce-form">
        <input type="hidden" name="view" value={debug ? "events" : "report"} />
        <div className="commerce-fields">
          <label>Dataset<select name="scope" defaultValue={test ? "test" : "live"}><option value="live">Live only</option><option value="test">Test only</option></select></label>
          <label>Market<select name="market" defaultValue={marketId}>
            {allowed.map(id => <option key={id} value={id}>{marketConfiguration(id).name}</option>)}
            {allowed.length > 1 && <option value="all">Compare markets</option>}
          </select></label>
        </div>
        <div className="commerce-fields">
          <label>From<input name="from" type="date" defaultValue={report?.window.from} /></label>
          <label>Through (inclusive)<input name="to" type="date" defaultValue={report?.window.to} /></label>
        </div>
        <button className="button button--outline" type="submit">Update report</button>
      </form>
      <p className="commerce-muted">Choose up to seven calendar days from the last 30 days, in {market.timeZone}.</p>
    </section>
    {report?.kind === "report" ? debug ? <>
      <section className="commerce-panel commerce-stack">
        <h2>Recent events</h2>
        <p>Last 60 observations and matched business outcomes. References are event IDs. Times are in {market.timeZone}.</p>
        {!report.debug.length ? <p>No events for this window and dataset.</p> :
          <div className="acquisition-table" role="region" aria-label="Recent events table" tabIndex={0}><table>
            <thead><tr><th>Time</th><th>Event</th><th>Event reference</th><th>Variant / units</th><th>Campaign</th><th>Amount</th><th>Source</th></tr></thead>
            <tbody>{report.debug.map(row => <tr key={row.id}>
              <td>{clock.format(row.at)}</td><td>{names[row.kind] ?? row.kind}</td><td><code>{row.id.slice(0, 12)}</code></td>
              <td>{row.variantId ?? "—"}{row.quantity != null && ` / ${row.quantity}`}</td><td>{row.campaign ?? "Unknown"}</td>
              <td>{row.amountMinor != null && row.currency ? units(BigInt(row.amountMinor), row.currency) : "—"}</td>
              <td>{row.source ?? "—"}</td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      {report.sampleOrder && <section className="commerce-panel commerce-stack">
        <h2>GA4 booking payload preview</h2>
        <p>Matched test COD booking. Payment confirmation requires separate evidence. This preview sends no request.</p>
        <pre className="acquisition-payload" tabIndex={0}>{JSON.stringify(report.sampleOrder, null, 2)}</pre>
      </section>}
      {report.sampleConfirmation && <section className="commerce-panel commerce-stack">
        <h2>Confirmed transaction preview</h2>
        <p>Saved test payment evidence from the native order. The event reference is stable across replays.</p>
        <pre className="acquisition-payload" tabIndex={0}>{JSON.stringify(report.sampleConfirmation, null, 2)}</pre>
      </section>}
    </> : <>
      <MarketSummary market={market} test={test} behavior={report.behavior} commerce={report.commerce} forecast={report.forecast} />
      {report.bridgeCommerce.accepted > 0 && <section className="commerce-panel commerce-stack" aria-labelledby="bridged-outcomes">
        <h2 id="bridged-outcomes">External checkout outcomes</h2>
        <p>These orders are included in the market totals above.</p>
        <dl className="acquisition-scores">
          <div><dt>Orders booked</dt><dd>{report.bridgeCommerce.accepted}</dd></div>
          <div><dt>Delivered</dt><dd>{report.bridgeCommerce.delivered}</dd></div>
          <div><dt>COD collected</dt><dd>{report.bridgeCommerce.codCollected}</dd><dd>{money(report.bridgeCommerce.finance.codCollected, market)}</dd></div>
          <div><dt>Matched remittances</dt><dd>{report.bridgeCommerce.finance.remittanceOrders}</dd><dd>{money(report.bridgeCommerce.finance.remittanceNet, market)} net</dd></div>
        </dl>
      </section>}
      <section className="commerce-panel commerce-stack">
        <h2>Campaign funnel</h2>
        <p>{report.window.from} to {report.window.to}, {market.timeZone}. Journeys start at the first observed product view. Steps must occur in order within seven days.</p>
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
          <tbody>{[...(acquisitionCampaign.marketId === market.id ? [acquisitionCampaign.label] : []), null].map(label => {
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
      </section>
    </> : <p className="state-panel" role="status">{report ? "This window exceeds the report limit. Choose a shorter date range." : "The acquisition report is unavailable. Try again shortly."}</p>}
    <section className="commerce-panel commerce-stack">
      <h2>Measurement coverage</h2>
      <p>Order outcomes cover records available through the market’s configured commerce authority. External checkout requires a verified lifecycle bridge.</p>
      <p>Behavior totals use consenting shoppers. Qualified sessions require session identifiers, which are present on new events. Order totals also include orders without shopping measurement. Delivery and collection are based on saved fulfillment and payment evidence.</p>
      <p>GA4 and Meta delivery are disabled. Campaign spend and platform-attributed conversions: not connected to this report. No return on ad spend is calculated.</p>
    </section>
  </div>;
}

async function CrossMarketReport({ ids, test, from, to }: {
  ids: Awaited<ReturnType<typeof staffMarketIds>>;
  test: boolean;
  from?: string;
  to?: string;
}) {
  const now = new Date();
  const dataset = test ? "test" : "live";
  const rows = await Promise.all(ids.map(async marketId => ({
    market: marketConfiguration(marketId),
    report: await acquisitionReport({ marketId, test, from, to, now }).catch(() => null),
  })));
  const complete = rows.flatMap(({ market, report }) => report?.kind === "report" ? [{ market, report }] : []);
  const date = complete[0]?.report.window.to;
  const comparable = date && complete.length === rows.length && complete.every(({ report }) =>
    report.window.to === date && report.window.from === complete[0].report.window.from);
  const rateSheet = comparable ? configuredReportingFx(date, test) : null;
  const target = rateSheet && marketList.find(market => market.currency === rateSheet.currency);
  const consolidated = rateSheet && convertedTotal(complete.map(({ market, report }) =>
    ({ currency: market.currency, amount: report.commerce.finance.merchandiseCovered === report.commerce.accepted
      ? report.commerce.finance.merchandiseBooked : null })), rateSheet);
  return <div className="acquisition">
    <div className="commerce-intro">
      <h1 className="display-type">Compare markets</h1>
      <p>Compare activity across your assigned markets. Each row uses its market calendar and original currency.</p>
    </div>
    <section className="commerce-panel commerce-stack">
      <h2>{test ? "Test records only" : "Live records only"}</h2>
      <form action={storefrontPath("/staff/acquisition")} className="commerce-form">
        <input type="hidden" name="market" value="all" />
        <div className="commerce-fields">
          <label>Dataset<select name="scope" defaultValue={dataset}><option value="live">Live only</option><option value="test">Test only</option></select></label>
          <label>From<input name="from" type="date" defaultValue={from} /></label>
          <label>Through (inclusive)<input name="to" type="date" defaultValue={to} /></label>
        </div>
        <button className="button button--outline" type="submit">Update report</button>
      </form>
      <div className="acquisition-table" role="region" aria-label="Compare market metrics" tabIndex={0}><table>
        <thead><tr><th>Market and window</th><th>Qualified sessions</th><th>Searches / zero results</th><th>Product to cart</th>
          <th>Checkout to order</th><th>Orders</th><th>Paid / failed</th><th>Delivered</th><th>Collected / remitted COD</th>
          <th>Returns</th><th>Booked merchandise</th><th>Contribution profit</th></tr></thead>
        <tbody>{rows.map(({ market, report }) => {
          const href = `/staff/acquisition?market=${market.id}&scope=${dataset}${report ? `&from=${report.window.from}&to=${report.window.to}` : ""}`;
          const heading = <th scope="row"><Link href={href}>{market.name}</Link>{report && <><br />{report.window.from} to {report.window.to}<br />{market.timeZone}</>}</th>;
          if (report?.kind !== "report") return <tr key={market.id}>{heading}<td colSpan={11}>Unavailable for this window</td></tr>;
          const { behavior, commerce } = report;
          return <tr key={market.id}>{heading}<td>{behavior.qualified}</td><td>{behavior.searches} / {behavior.zeros}</td>
            <td>{rate(behavior.productToCart, behavior.productViews)}</td><td>{rate(behavior.checkoutToOrder, behavior.checkoutStarts)}</td>
            <td>{commerce.accepted}</td><td>{commerce.paid} / {commerce.providerFailures ?? "Unavailable"}</td><td>{commerce.delivered}</td>
            <td>{commerce.codCollected} / {commerce.finance.remittanceOrders}</td><td>{commerce.returned}</td>
            <td>{commerce.finance.merchandiseCovered === commerce.accepted ? money(commerce.finance.merchandiseBooked, market) : "Unavailable"}</td>
            <td>{commerce.contribution.total === null ? "Unavailable" : money(commerce.contribution.total, market)}</td></tr>;
        })}</tbody>
      </table></div>
    </section>
    <section className="commerce-panel commerce-stack">
      <h2>Consolidated booked merchandise</h2>
      {rateSheet && target && consolidated !== null
        ? <p>{money(consolidated, target)}. Reporting currency {rateSheet.currency}. Rate source {rateSheet.source}, dated {rateSheet.asOf}. Each local market subtotal uses the period-end rate and rounds half up to the reporting currency’s minor unit before addition.</p>
        : <p>Unavailable. Consolidation requires complete merchandise evidence, matching local date windows and a rate sheet for the closing date and all listed currencies.</p>}
    </section>
  </div>;
}
