import Link from "next/link";
import { storefrontPath } from "@/config/storefront-path";
import type { DemandForecast, ForecastModel } from "@/lib/intelligence/forecast";
import type { loadForecastBoard } from "@/lib/intelligence/forecast-board";
import type { InventoryRecommendation } from "@/lib/intelligence/inventory";
import { intelligencePath, intelligenceUrl } from "@/lib/intelligence/navigation";
import type { ProductIntelligenceReport, ProductIntelligenceRow } from "@/lib/intelligence/types";
import { marketConfiguration } from "@/lib/market-config";
import { money } from "../acquisition/market-summary";
import { DraftFromInsight, type DraftPermission } from "./intelligence-overview";
import { IntelligenceTable, Scores, TextList } from "./intelligence-ui";

const modelNames: Record<ForecastModel, string> = {
  "recent-mean": "Recent daily mean", "weekly-naive": "Weekly seasonal naïve", "croston-sba": "Croston SBA",
};
const units = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
const ratio = (value: number | null) => value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
type Board = Awaited<ReturnType<typeof loadForecastBoard>>;

function ForecastDetails({ forecast, row }: { forecast: DemandForecast; row: ProductIntelligenceRow }) {
  const range = forecast.interval ? `${forecast.interval.lowerUnits}–${forecast.interval.upperUnits} units` : "Unavailable";
  const evidence = forecast.evidence;
  const product = row.variantName ? `${row.name} · ${row.variantName}` : row.name;
  return <article className="intel-card">
    <h3>{product}</h3>
    <p className="intel-meta">{forecast.identity.marketId.toUpperCase()} · {forecast.horizonDays} days from {forecast.asOfDay} · {forecast.model ? modelNames[forecast.model] : forecast.status === "analogue" ? "Analogue estimate" : "Insufficient evidence"}</p>
    <Scores entries={[{ label: "Expected booked units", value: units(forecast.pointUnits) }, { label: forecast.interval ? `${ratio(forecast.interval.nominalCoverage)} prediction range` : "Prediction range", value: range }]} />
    {forecast.analogue && <p>Reviewed comparable {forecast.analogue.identity.productId}{forecast.analogue.identity.variantId && ` / ${forecast.analogue.identity.variantId}`} in {forecast.analogue.identity.marketId.toUpperCase()}. {forecast.analogue.rationale} Assumption range {forecast.analogue.scenarioRangeUnits.lowerUnits}–{forecast.analogue.scenarioRangeUnits.upperUnits} units.</p>}
    <p className="intel-muted">{evidence.availableUnpromotedDays} available unpromoted days · {evidence.stockoutDays} stockout days · {evidence.partialDays} partial days · {evidence.unknownAvailabilityDays} unknown days · {evidence.promotedDays} promoted days · {evidence.observedReturnedUnits} returned units recorded separately.</p>
    <TextList entries={forecast.limitations} />
    {forecast.comparisons.some(item => item.windows) && <details><summary>Rolling holdout results</summary>
      <IntelligenceTable label={`Backtest results for ${product}`} columns={["Baseline", "Windows", "MAE (units)", "Bias (units)", "WAPE", "Interval coverage"]}>
        {forecast.comparisons.filter(item => item.windows).map(item => <tr key={item.model}><th scope="row">{modelNames[item.model]}</th>
          <td>{item.windows}</td><td>{units(item.meanAbsoluteError)}</td><td>{units(item.meanSignedError)}</td><td>{ratio(item.wape)}</td>
          <td>{ratio(item.intervalCoverage)}{item.intervalWindows > 0 && ` (${item.intervalWindows} windows)`}</td></tr>)}
      </IntelligenceTable>
    </details>}
  </article>;
}

function StockRecommendation({ row, stock, report, permission }: {
  row: ProductIntelligenceRow; stock: InventoryRecommendation; report: ProductIntelligenceReport; permission: DraftPermission;
}) {
  const market = marketConfiguration(report.marketId);
  const cost = (value: number | null) => value !== null && market.currency === stock.currency ? money(BigInt(value), market)
    : value !== null ? `${value} minor units (${stock.currency})` : "Unavailable";
  const label = row.variantName ? `${row.name} · ${row.variantName}` : row.name;
  const href = intelligenceUrl({ market: market.id, scope: report.test ? "test" : "live", view: "forecast", from: report.window.from,
    to: report.window.to, product: row.productId, variant: row.variantId ?? undefined, section: "stock-risk" });
  return <article className="intel-card">
    <h3>{label}</h3>
    <p className="intel-meta">{stock.action.replaceAll("-", " ")} · {stock.poolId ?? "Unverified physical pool"}</p>
    <dl className="intel-definitions">
      <div><dt>Available</dt><dd>{units(stock.available)}</dd></div>
      <div><dt>Reserved</dt><dd>{units(stock.reserved)}</dd></div>
      <div><dt>Incoming in planning window</dt><dd>{units(stock.incomingDuringHorizon)}</dd></div>
      <div><dt>Suggested units</dt><dd>{units(stock.quantity)}</dd></div>
      <div><dt>Supplier unit price</dt><dd>{cost(stock.unitCostMinor)}</dd></div>
      <div><dt>Proposal cost</dt><dd>{cost(stock.estimatedCostMinor)}</dd></div>
      <div><dt>Configured budget</dt><dd>{cost(stock.availableBudgetMinor)}</dd></div>
    </dl>
    {stock.source && <p className="intel-muted">{stock.source} · verified through {stock.sourceAsOfDay}</p>}
    <TextList entries={stock.reasons} />
    {stock.missingInputs.length > 0 && <><h4>Inputs to verify</h4><TextList entries={stock.missingInputs} /></>}
    <DraftFromInsight permission={{ ...permission, merchandising: false }} evidence={{ sourceId: `inventory:${row.variantId}`,
      marketId: market.id, test: report.test, from: report.window.from, to: report.window.to, title: `${label} purchasing review`,
      productId: row.productId, variantId: row.variantId ?? undefined, facts: stock.reasons.slice(0, 6), href, quantity: stock.quantity ?? undefined,
      hypothesis: "Confirm inventory, supplier terms and incoming quantities before approving a purchase." }} />
  </article>;
}

export function ForecastBoard({ report, board, permission, horizonDays }: {
  report: ProductIntelligenceReport; board: Board; permission: DraftPermission; horizonDays: number;
}) {
  const products = report.products.filter(row => row.variantId === null);
  const variants = report.products.filter(row => row.variantId !== null && row.productId === board.selectedProductId);
  const scope = report.test ? "test" : "live";
  const url = (product?: string, variant?: string) => intelligenceUrl({ market: report.marketId, scope, view: "forecast", from: report.window.from,
    to: report.window.to, product, variant, horizon: horizonDays });
  const stocks = board.entries.filter(entry => entry.inventory !== null);
  return <>
    <section className="commerce-panel intel-panel" id="forecasts">
      <h2>Product and variant forecasts</h2>
      <form className="commerce-form" action={storefrontPath(intelligencePath)}>
        <input type="hidden" name="market" value={report.marketId} /><input type="hidden" name="scope" value={scope} /><input type="hidden" name="view" value="forecast" />
        <input type="hidden" name="from" value={report.window.from} /><input type="hidden" name="to" value={report.window.to} />
        {board.selectedVariantId && board.selectedProductId && <>
          <input type="hidden" name="variantFor" value={board.selectedProductId} />
          <input type="hidden" name="variant" value={board.selectedVariantId} />
        </>}
        <div className="commerce-fields">
          <label>Product<select name="product" defaultValue={board.selectedProductId ?? ""}>
            <option value="">Market shortlist</option>{products.map(product => <option key={product.productId} value={product.productId}>{product.name}</option>)}
          </select></label>
          <label>Horizon (days)<input name="horizon" type="number" min={1} max={56} defaultValue={horizonDays} required /></label>
        </div>
        <button type="submit" className="button button--outline">Update forecast</button>
      </form>
      {board.selectedProductId && variants.length > 0 && <nav className="intel-tabs" aria-label="Product variants">
        <Link className="button button--outline" href={url(board.selectedProductId)} aria-current={!board.selectedVariantId ? "page" : undefined}>Product total</Link>
        {variants.slice(0, 24).map(row => <Link className="button button--outline" key={row.variantId} href={url(row.productId, row.variantId!)}
          aria-current={row.variantId === board.selectedVariantId ? "page" : undefined}>{row.variantName ?? row.variantId}</Link>)}
      </nav>}
      <p className="intel-muted">Forecasts use booked units on the booking date. Confirmed promotions, constrained days and unknown availability are excluded from baseline fitting. Returns are reported separately because they can arrive later.</p>
      {board.selectionUnavailable && <p role="status">The selected product or variant is unavailable in this market.</p>}
      {board.omitted > 0 && <p className="intel-muted">{board.omitted} additional series are available by product selection.</p>}
      {board.entries.length ? <div className="intel-grid">{board.entries.map(({ forecast, row }) => <ForecastDetails key={`${row.productId}/${row.variantId ?? "all"}`} row={row} forecast={forecast} />)}</div>
        : <p>Insufficient evidence for this selection.</p>}
    </section>
    <section className="commerce-panel intel-panel" id="backtests">
      <h2>Model comparison by product group</h2>
      {board.evaluation.length ? <IntelligenceTable label="Market and group baseline comparison" columns={["Market and group", "Level", "Baseline", "Series / windows", "MAE", "Bias", "WAPE", "Interval coverage"]}>
        {board.evaluation.map(item => <tr key={`${item.group}/${item.level}/${item.model}`}><th scope="row">{item.marketId.toUpperCase()} · {item.group}</th><td>{item.level}</td>
          <td>{modelNames[item.model]}</td><td>{item.evaluatedSeries} / {item.windows}</td><td>{units(item.meanAbsoluteError)}</td><td>{units(item.meanSignedError)}</td><td>{ratio(item.wape)}</td><td>{ratio(item.intervalCoverage)}</td></tr>)}
      </IntelligenceTable> : <p>No sufficiently complete holdout windows for the selected series and horizon.</p>}
      <p className="intel-muted">Each holdout is evaluated using evidence that predates its origin. Bias is forecast minus actual. Results describe the selected series in this market.</p>
    </section>
    <section className="commerce-panel intel-panel" id="stock-risk"><h2>Stock risk and replenishment</h2>
      <p>{board.purchasingState === "fixture" ? "Staging purchasing fixtures cover selected review variants. Other variants show missing inputs." :
        board.purchasingState === "ready" ? "Dated purchasing inputs are configured. Review coverage and source on each variant." : board.purchasingState === "invalid"
        ? "The purchasing policy input is invalid. Quantities are unavailable." : "A verified purchasing feed is unavailable. Quantities require dated supplier terms and stock inputs."}</p>
      {stocks.length ? <div className="intel-grid">{stocks.map(entry => <StockRecommendation key={entry.row.variantId} row={entry.row}
        stock={entry.inventory!} report={report} permission={permission} />)}</div> : <p>Choose a variant with inventory evidence to review its physical stock pool.</p>}
    </section>
  </>;
}
