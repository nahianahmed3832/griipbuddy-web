import Link from "next/link";
import { notFound } from "next/navigation";
import { currentMarket } from "@/lib/market-server";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { reportFailure } from "@/lib/db/observability";
import { loadOperationsReport, OperationsReportError, reportQuery, reportViews, type OperationsReport, type ReportView } from "@/lib/staff/operations-report";
import { reportTables } from "@/lib/staff/operations-report-table";
import { staffMarketIds } from "@/lib/staff/market-access";
import { sellerFinanceTestEnabled } from "@/lib/marketplace/seller-finance";
import { storefrontPath } from "@/config/storefront-path";
import styles from "./operations-report.module.css";

const route = "/staff/operations-reporting";
type Raw = Record<string, string | string[] | undefined>;

function links(input: OperationsReport["input"], extra: Record<string, string | number | undefined> = {}) {
  const values = { market: input.marketId, from: input.range.from, to: input.range.to, view: input.view, mode: input.mode,
    location: input.location, compare: input.compare, ...extra };
  return new URLSearchParams(Object.entries(values).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]])).toString();
}

function ReportControls({ report }: { report: OperationsReport }) {
  const { input, allowed, owner, activity } = report;
  const views = (Object.entries(reportViews) as [ReportView, string][]).filter(([id]) => (id !== "stock" || owner) &&
    (id !== "activity" || activity));
  return <>
    <form method="get" action={storefrontPath(route)} className={styles.filters}>
      <input type="hidden" name="view" value={input.view}/>
      {input.fixture && <label>Evidence cohort<select name="mode" defaultValue={input.mode}>
        <option value="fixture">Synthetic fixture</option><option value="operating">Operating records</option>
      </select></label>}
      <label>Market<select name="market" defaultValue={input.marketId}>
        {allowed.map(id => <option value={id} key={id}>{marketConfiguration(id).name}</option>)}
      </select></label>
      <label>Start date<input type="date" name="from" defaultValue={input.range.from} required/></label>
      <label>End date<input type="date" name="to" defaultValue={input.range.to} required/></label>
      {input.view === "daily" && <label>Compare<select name="compare" defaultValue={input.compare}>
        <option value="none">No comparison</option><option value="previous">Previous equal period</option>
      </select></label>}
      {report.stock && <label>Warehouse<select name="location" defaultValue={input.location ?? ""}>
        <option value="">All eligible warehouses</option>
        {report.stock.locations.map(site => <option value={site.id} key={site.id}>{site.name}</option>)}
      </select></label>}
      <button className="button button--primary">Apply filters</button>
    </form>
    <nav className={styles.reportNav} aria-label="Report views">
      {views.map(([id, label]) => <Link className="button button--secondary" aria-current={id === input.view ? "page" : undefined}
        href={route + "?" + links(input, { view: id, location: id === "stock" ? input.location : undefined })} key={id}>{label}</Link>)}
    </nav>
  </>;
}

function ReportMetrics({ report }: { report: OperationsReport }) {
  const { orders, demand, stock, catalogCount, input } = report;
  const selected = marketConfiguration(input.marketId);
  const money = new Intl.NumberFormat(selected.defaultLocale, { style: "currency", currency: selected.currency });
  const amount = (minor: number) => money.format(minor / 10 ** selected.minorDigits);
  const sum = orders?.totals;
  const completion = orders && orders.totals.orders
    ? new Intl.NumberFormat(selected.defaultLocale, { style: "percent", maximumFractionDigits: 1 }).format(orders.placedDelivered / orders.totals.orders)
    : "—";
  const entries: [string, string | number][] = [
    ...(sum && input.view === "daily" ? [
      ["Orders placed", sum.orders], ["Booked order value", amount(sum.bookedMinor)],
      ["Placed orders delivered to date", completion], ["Delivered during period", sum.delivered],
      ["Registered buyers with orders", orders.registered], ["Guest orders", orders.guestOrders],
      ["Confirmed online payments", amount(sum.onlineMinor)], ["COD collected", amount(sum.codMinor)],
      ["Matched carrier remittance", amount(sum.remittedMinor)], ["Confirmed refunds", amount(sum.refundedMinor)],
      ["Cash activity after refunds", amount(sum.onlineMinor + sum.codMinor - sum.refundedMinor)],
      ["Online payment failure evidence", orders.failureEvidence ? sum.paymentFailures : "Unavailable"],
    ] as [string, string | number][] : []),
    ...(catalogCount !== null ? [["Currently eligible products", catalogCount]] as [string, number][] : []),
    ...(stock ? [["Visible physical pools", stock.rows.length]] as [string, number][] : []),
    ...(demand ? [["Measured searches", demand.searches], ["Zero-result searches", demand.zeroResults]] as [string, number][] : []),
  ];
  return entries.length ? <dl className={styles.cards}>
    {entries.map(([name, value]) => <div className="commerce-panel" key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
  </dl> : null;
}

function ReportComparison({ report }: { report: OperationsReport }) {
  if (!report.comparison || !report.orders) return null;
  const { from, to } = report.comparison.range;
  const current = report.orders.totals, previous = report.comparison.totals;
  const comparison = [
    ["Orders placed", current.orders, previous.orders],
    ["Confirmed online in minor units", current.onlineMinor, previous.onlineMinor],
    ["COD collected in minor units", current.codMinor, previous.codMinor],
    ["Carrier remitted in minor units", current.remittedMinor, previous.remittedMinor],
    ["Refunded in minor units", current.refundedMinor, previous.refundedMinor],
  ];
  return <section className={styles.tableSection} aria-label="Previous equal period comparison">
    <h2>Previous period comparison</h2><p>{from} to {to} in the same market and evidence cohort</p>
    <div className={styles.tableScroll} role="region" aria-label="Previous period table" tabIndex={0}>
      <table><thead><tr><th scope="col">Measure</th><th scope="col">Selected</th><th scope="col">Previous</th></tr></thead>
        <tbody>{comparison.map(([label, a, b]) => <tr key={label}><th scope="row">{label}</th><td>{a}</td><td>{b}</td></tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function ReportRecords({ report }: { report: OperationsReport }) {
  const { input, pageSize } = report;
  const start = (input.page - 1) * pageSize;
  const tables = reportTables(report);
  return <>
    {tables.map((table, index) => {
      const rows = table.rows.slice(start, start + pageSize);
      return <section key={table.name} aria-label={table.name} className={styles.tableSection}>
        <div className={styles.tableHeading}>
          <h2>{table.name}</h2>
          <a className="button button--secondary" href={storefrontPath("/api/staff/operations-reporting?") + links(input, { table: index + 1 })}
            >Download CSV</a>
        </div>
        {rows.length ? <div className={styles.tableScroll} role="region" aria-label={table.name + " table"} tabIndex={0}>
          <table><thead><tr>{table.columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell === null ? "—" :
              typeof cell === "object" ? <Link href={cell.href}>{cell.label}</Link> : cell}</td>)}</tr>)}</tbody></table>
        </div> : <p>No eligible records on this page.</p>}
      </section>;
    })}
    <nav className={styles.reportNav} aria-label="Report pages">
      {input.page > 1 && <Link href={route + "?" + links(input, { page: input.page - 1 })}>Previous page</Link>}
      {tables.some(table => table.rows.length > start + pageSize) &&
        <Link href={route + "?" + links(input, { page: input.page + 1 })}>Next page</Link>}
    </nav>
  </>;
}

export const metadata = { title: "Operations reports", robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<Raw> }) {
  const [actor, selected, raw] = await Promise.all([requireStaff(), currentMarket(), searchParams]);
  const allowed = await staffMarketIds(actor.id, "reporting");
  if (!allowed.length) notFound();
  let report;
  try {
    const market = allowed.includes(selected.id) ? selected.id : allowed[0];
    const query = raw.location === "" ? { ...raw, location: undefined } : raw;
    report = await loadOperationsReport(actor.id, reportQuery(query, market, process.env.BETTER_AUTH_URL ?? ""));
  } catch (error) {
    if (!(error instanceof OperationsReportError)) reportFailure("staff.operations-report", undefined, error);
    const message = error instanceof OperationsReportError ? error.message : "Reports are temporarily unavailable.";
    return <section className={styles.workspace}><h1>Operations reports</h1><p role="alert">{message}</p>
      <Link href={route}>Reset report filters</Link></section>;
  }
  const { input } = report;
  const market = marketConfiguration(input.marketId);
  return <section className={styles.workspace}>
    <header><h1>Operations reports</h1>
      <p>{market.name} · {market.currency} · {market.timeZone} · {input.mode === "fixture" ? "Synthetic fixture" : "Operating records"}</p>
      <p className="commerce-muted">Native Storefront · Snapshot taken {input.now.toISOString()}</p>
    </header>
    <ReportControls report={report}/>
    <ReportMetrics report={report}/>
    {input.view === "daily" && <p>Booked value, confirmed payments, COD collection, remittance and refunds are separate measures.
      Historical rows without evidence are excluded. {report.orders?.unclassified || 0} unclassified bookings in this period.</p>}
    {input.view === "organizations" && <p>Order-time line value after merchandise discounts. Tax, shipping, payment confirmation and seller settlement are separate.</p>}
    {input.view === "products" && <p>Sales quantities and values use recorded purchase lines. Brand and category use the current catalog.</p>}
    {input.view === "stock" && <p>Current market-routed pools by SKU, warehouse and owner. Shared pools can appear in multiple markets and must be counted once in any combined reconciliation.</p>}
    {input.view === "demand" && <p>Consented non-automated activity within retention. Search labels require at least three distinct sessions. Wishlist data counts add activity.</p>}
    <ReportComparison report={report}/>
    <ReportRecords report={report}/>
    {report.owner && sellerFinanceTestEnabled() && <Link href={"/staff/seller-finance?" + links(input, { view: undefined, mode: undefined, location: undefined, compare: undefined })}>
      Open synthetic seller finance statement
    </Link>}
  </section>;
}
