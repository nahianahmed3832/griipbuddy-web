import Link from "next/link";
import type { MarketId } from "@/config/markets";
import { CreateIntelligenceDraft } from "@/components/intelligence-draft-forms";
import { draftTypes, signDraftEvidence, type DraftEvidence } from "@/lib/intelligence/drafts";
import { intelligenceUrl } from "@/lib/intelligence/navigation";
import type { OpportunityAssessment } from "@/lib/intelligence/opportunities";
import type { ProductIntelligenceReport, ProductIntelligenceRow } from "@/lib/intelligence/types";
import { marketConfiguration } from "@/lib/market-config";
import { configuredReportingFx, convertedTotal } from "@/lib/measurement/reporting-fx";
import { money } from "../acquisition/market-summary";
import { IntelligenceTable, percentage, Scores, TextList } from "./intelligence-ui";

export type DraftPermission = { actorId: string; merchandising: boolean; operations: boolean };

export function DraftFromInsight({ evidence, permission }: { evidence: DraftEvidence; permission: DraftPermission }) {
  const options = (Object.keys(draftTypes) as (keyof typeof draftTypes)[]).filter(kind => {
    if (kind === "PURCHASING") return permission.operations && evidence.productId;
    return permission.merchandising && (kind === "PRODUCT_TEST" || evidence.productId);
  }).map(kind => ({ value: kind, label: draftTypes[kind] }));
  const signature = options.length ? signDraftEvidence(permission.actorId, evidence) : null;
  return signature ? <CreateIntelligenceDraft evidence={signature} options={options} /> : null;
}

function rowKey(row: ProductIntelligenceRow) {
  return `${row.productId}/${row.variantId ?? "product"}`;
}

function ProductRows({ rows, report }: { rows: ProductIntelligenceRow[]; report: ProductIntelligenceReport }) {
  const market = marketConfiguration(report.marketId);
  const value = (amount: bigint | number | null) => amount === null ? "Unavailable" : money(BigInt(amount), market);
  return <IntelligenceTable label="Product activity" columns={[
    "Product or variant", "Visible impressions", "Unique viewing journeys", "Wishlist + / −", "Cart + / −", "Checkout sessions", "Booked units", "Paid units",
    "Cancelled", "Delivered", "Returned units", "COD collected / remitted", "Current price / discount", "Observed price range", "Available stock / stockout days", "Contribution",
  ]}>{rows.map(row => <tr key={rowKey(row)}>
    <th scope="row"><Link href={intelligenceUrl({ market: report.marketId, scope: report.test ? "test" : "live", view: "forecast",
      product: row.productId, variant: row.variantId ?? undefined, from: report.window.from, to: report.window.to })}>{row.name}</Link>
      {row.variantName && <div>{row.variantName}</div>}{!row.eligible && <small>Currently ineligible</small>}</th>
    <td>{row.metrics.impressions}</td><td>{row.metrics.viewers}</td><td>{row.metrics.wishlistAdds} / {row.metrics.wishlistRemoves}</td>
    <td>{row.metrics.cartAdds} / {row.metrics.cartRemoves}</td><td>{row.metrics.checkoutSessions}</td>
    <td>{row.metrics.bookedUnits}</td><td>{row.metrics.paidUnits}</td><td>{row.metrics.cancelledOrders}</td>
    <td>{row.metrics.deliveredOrders}</td><td>{row.metrics.returnedUnits}</td><td>{row.metrics.codCollectedOrders} / {row.metrics.codRemittedOrders}</td>
    <td>{value(row.availability.currentPriceMinor)} / {value(row.availability.currentDiscountMinor)}</td>
    <td>{row.availability.priceMinMinor === null || row.availability.priceMaxMinor === null ? "Unavailable"
      : `${value(row.availability.priceMinMinor)} – ${value(row.availability.priceMaxMinor)}`} <small className="intel-muted"> · {row.availability.promotionDays} promoted days</small></td>
    <td>{row.availability.available ?? "Unavailable"} / {row.availability.stockoutDays}<small className="intel-muted"> · {row.availability.unknownDays} unknown days</small></td>
    <td>{value(row.finance.contributionMinor)} <small className="intel-muted">· {row.finance.completeOrders}/{row.finance.requiredOrders} orders covered</small></td>
  </tr>)}</IntelligenceTable>;
}

export function QualityPanel({ report }: { report: ProductIntelligenceReport }) {
  const market = marketConfiguration(report.marketId);
  const clock = new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeStyle: "short", timeZone: market.timeZone });
  return <section id="quality" className="commerce-panel intel-panel">
    <h2>Cost completeness and data quality</h2>
    <IntelligenceTable label="Data sources" columns={["Source", "Coverage", "Latest evidence", "Records", "Provenance and limitations"]}>
      {report.quality.map(source => <tr key={source.id}><th scope="row">{source.source}</th><td>{source.status}</td>
        <td>{source.latestAt ? clock.format(source.latestAt) : "Unavailable"}</td><td>{source.observed ?? "Unavailable"}</td><td>{source.notes}</td></tr>)}
    </IntelligenceTable>
    <p className="intel-muted">{report.market.unmappedOrders} verified orders have no reliable product mapping. {report.market.unclassifiedOrders} orders have unknown evidence classification and are outside the selected dataset.</p>
  </section>;
}

export function Overview({ report, assessments, permission }: {
  report: ProductIntelligenceReport; assessments: OpportunityAssessment[]; permission: DraftPermission;
}) {
  const market = marketConfiguration(report.marketId);
  const { window, products, searches } = report;
  const scope = report.test ? "test" : "live";
  const pRows = products.filter(row => row.variantId === null);
  const vRows = products.filter(row => row.variantId !== null);
  const totals = report.market;
  const format = (amount: bigint | null) => amount === null ? "Unavailable" : money(amount, market);
  const activityWithPlacement = [...pRows].sort((a, b) => b.metrics.impressions - a.metrics.impressions).filter(row => row.metrics.impressions).slice(0, 8);
  const rowsWithCosts = pRows.filter(row => row.finance.requiredOrders || row.finance.completeOrders);
  return <>
    <Scores entries={[
      { label: "Visible impressions", value: totals.impressions }, { label: "Unique product viewers", value: totals.viewers },
      { label: "Verified paid or collected orders", value: totals.paidOrders },
      { label: `Verified collections in ${report.currency}`, value: format(totals.collectedMinor) },
    ]} />
    <section className="commerce-panel intel-panel" id="opportunities"><h2>Demand and assortment opportunities</h2>
      {assessments.length ? <div className="intel-grid">{assessments.slice(0, 12).map(item => <article className="intel-card" key={item.id}>
        <h3>{item.title}</h3><div className="intel-meta">{item.signal.replaceAll("-", " ")} · {item.confidence} evidence · sample {item.sample}</div>
        <TextList entries={item.facts}/><p><strong>Hypothesis</strong> {item.hypothesis}</p>
        <TextList entries={item.limitations}/><Link href={item.href}>Review supporting evidence</Link>
        <DraftFromInsight permission={permission} evidence={{ sourceId: item.id, marketId: report.marketId, test: report.test,
          from: window.from, to: window.to, title: item.title, facts: item.facts.slice(0, 6), hypothesis: item.hypothesis,
          productId: item.productId, variantId: item.variantId ?? undefined, href: item.href }} />
      </article>)}</div> : <p>Insufficient evidence for a product or assortment opportunity in this period.</p>}
    </section>
    <section className="commerce-panel intel-panel" id="search"><h2>Search demand and unmet queries</h2>
      <Scores entries={[{ label: "Searches", value: searches.searches }, { label: "Unique searchers", value: searches.searchers },
        { label: "Zero-result searches", value: searches.zeroResults }, { label: "Query reformulations", value: searches.reformulations },
        { label: "Filter changes", value: searches.filterChanges }]} />
      {searches.terms.length ? <IntelligenceTable label="Search terms" columns={["Query", "Searches", "Unique searchers", "Zero results", "Reformulations"]}>
        {searches.terms.slice(0, 30).map(row => <tr key={row.term}><th scope="row">{row.term}</th><td>{row.searches}</td>
          <td>{row.searchers}</td><td>{row.zeroResults}</td><td>{row.reformulations}</td></tr>)}
      </IntelligenceTable> : <p>No search terms met the reporting threshold.</p>}
      <p className="intel-muted">Repeated no-result queries show interest and merit investigation. Availability, exposure, language, and search synonyms affect the result.</p>
    </section>
    <section className="commerce-panel intel-panel" id="conversion"><h2>Conversion bottlenecks and commerce outcomes</h2>
      <IntelligenceTable label="Market conversion" columns={["Stage", "Count", "Evidence"]}>
        <tr><th scope="row">Viewed then added to cart</th><td>{totals.viewedThenCart}</td><td>{percentage(totals.viewedThenCart, totals.viewers)} of viewing journeys</td></tr>
        <tr><th scope="row">Viewed then began checkout</th><td>{totals.viewedThenCheckout}</td><td>{percentage(totals.viewedThenCheckout, totals.viewers)} of viewing journeys</td></tr>
        <tr><th scope="row">Viewed then verified payment</th><td>{totals.viewedThenPaid}</td><td>{percentage(totals.viewedThenPaid, totals.viewers)} of viewing journeys</td></tr>
        <tr><th scope="row">Checkout errors / verified payment failures</th><td>{totals.checkoutErrors} / {totals.paymentFailures ?? "Unavailable"}</td><td>Observed checkout errors and provider evidence</td></tr>
        <tr><th scope="row">Booked / cancelled orders</th><td>{totals.bookedOrders} / {totals.cancelledOrders}</td><td>{totals.bookedUnits} units, {totals.discountedUnits} booked with a discount</td></tr>
        <tr><th scope="row">Delivered / returned orders</th><td>{totals.deliveredOrders} / {totals.returnedOrders}</td><td>{totals.returnedUnits} units returned</td></tr>
        <tr><th scope="row">COD collected / remitted orders</th><td>{totals.codCollectedOrders} / {totals.codRemittedOrders}</td><td>{format(totals.remittedMinor)} matched remittance</td></tr>
      </IntelligenceTable>
      <Link href={`/staff/acquisition?market=${report.marketId}&scope=${scope}`}>Inspect acquisition and reconciliation</Link>
    </section>
    <section className="commerce-panel intel-panel" id="products"><h2>Product and variant activity</h2>
      {pRows.length ? <ProductRows rows={pRows.slice(0, 45)} report={report} /> : <p>No mapped products in this period.</p>}
      {vRows.length > 0 && <details><summary>View variant-level activity</summary><ProductRows rows={vRows.slice(0, 65)} report={report} /></details>}
      {(pRows.length > 45 || vRows.length > 65) && <p className="intel-muted">This overview shows up to 45 products and 65 variants. Search and select a product in Forecasts and stock for its individual view.</p>}
      {activityWithPlacement.length > 0 && <details><summary>View impressions by placement and tagged traffic</summary>
        <IntelligenceTable label="Placement and campaign evidence" columns={["Product", "Visible impressions by placement", "Viewing / paid journeys by campaign source"]}>
          {activityWithPlacement.map(row => <tr key={rowKey(row)}><th scope="row">{row.name}</th><td>{row.metrics.impressionsByPlacement.map(p => `${p.placement} ${p.count}`).join(" · ") || "Unavailable"}</td>
            <td>{row.metrics.campaignVisits.map(p => `${p.source} ${p.viewers} / ${p.paidJourneys}`).join(" · ") || "Unavailable"}</td></tr>)}
        </IntelligenceTable>
      </details>}
      {rowsWithCosts.length > 0 && <details><summary>View product cost evidence</summary>
        <IntelligenceTable label="Product cost evidence" columns={["Product", "Merchandise booked", "Collected", "Product", "Packaging", "Outbound", "Payment", "Returns", "Contribution", "Missing inputs"]}>
          {rowsWithCosts.slice(0, 30).map(row => <tr key={rowKey(row)}><th scope="row">{row.name}</th>
            {[row.finance.bookedMerchandiseMinor, row.finance.collectedMinor, row.finance.itemCostMinor, row.finance.packagingMinor,
              row.finance.outboundMinor, row.finance.paymentFeesMinor, row.finance.returnMinor, row.finance.contributionMinor].map((value, index) => <td key={index}>{format(value)}</td>)}
            <td>{row.finance.missing.join(" · ") || "None reported"}</td></tr>)}
        </IntelligenceTable>
      </details>}
    </section>
    <QualityPanel report={report} />
  </>;
}

export function Consolidated({ reports, markets, test }: { reports: ProductIntelligenceReport[]; markets: MarketId[]; test: boolean }) {
  const sameWindow = reports.length === markets.length && reports.length > 1 && reports.every(({ window }) =>
    window.from === reports[0].window.from && window.to === reports[0].window.to);
  const provenance = sameWindow ? configuredReportingFx(reports[0].window.to, reports[0].test) : null;
  const converted = provenance ? convertedTotal(reports.map(report => ({ currency: report.currency, amount: report.market.collectedMinor })), provenance) : null;
  const reportingMarket = provenance && markets.map(marketConfiguration).find(market => market.currency === provenance.currency);
  return <section className="commerce-panel intel-panel" id="market-comparison">
    <h2>Compare authorized markets</h2>
    <IntelligenceTable label="Market comparison" columns={["Market", "Local window", "Currency", "Viewing journeys", "Searches / zero results", "Paid orders", "Units booked", "Verified collections"]}>
      {markets.map(id => {
        const market = marketConfiguration(id);
        const report = reports.find(item => item.marketId === id);
        return <tr key={id}><th scope="row"><Link href={intelligenceUrl({ market: id, scope: test ? "test" : "live", from: report?.window.from, to: report?.window.to })}>{market.name}</Link></th>
          {report ? <><td>{report.window.from} – {report.window.to}</td><td>{report.currency}</td><td>{report.market.viewers}</td>
            <td>{report.searches.searches} / {report.searches.zeroResults}</td><td>{report.market.paidOrders}</td><td>{report.market.bookedUnits}</td>
            <td>{money(report.market.collectedMinor, market)}</td></> : <td colSpan={7}>Report unavailable for this period.</td>}</tr>;
      })}
    </IntelligenceTable>
    {provenance && reportingMarket && converted !== null ? <p>Converted collections {money(converted, reportingMarket)} {provenance.currency}. Rate sheet {provenance.asOf} from {provenance.source}. Each market subtotal is converted at target currency per source major unit and rounded half up before summing.</p>
      : <p className="intel-muted">Each market keeps its original currency. A consolidated amount requires a complete dated rate sheet for the same reporting period in all selected markets.</p>}
  </section>;
}
