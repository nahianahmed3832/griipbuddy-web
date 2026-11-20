import Link from "next/link";
import { notFound } from "next/navigation";
import { isMarketId, type MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { IntelligenceAnalyst } from "@/components/intelligence-analyst";
import { reportFailure } from "@/lib/db/observability";
import { analystQuestions } from "@/lib/intelligence/analyst";
import { productIntelligence } from "@/lib/intelligence/dataset";
import { loadForecastBoard } from "@/lib/intelligence/forecast-board";
import { loadOpportunityAssessments } from "@/lib/intelligence/load-report";
import { intelligencePath, intelligenceUrl, type IntelligenceScope, type IntelligenceView } from "@/lib/intelligence/navigation";
import type { IntelligenceInput, IntelligenceWindow, ProductIntelligenceReport } from "@/lib/intelligence/types";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { IntelligenceDrafts } from "./intelligence-drafts";
import { ForecastBoard } from "./intelligence-forecast";
import { Consolidated, Overview } from "./intelligence-overview";
import "./intelligence.css";

export const metadata = { title: "Product Intelligence", robots: { index: false, follow: false } };

const views = { overview: "Overview", forecast: "Forecasts and stock", analyst: "Analyst", drafts: "Drafts and outcomes" } as const;

async function readReport(input: IntelligenceInput) {
  try { return await productIntelligence(input); }
  catch (error) { reportFailure("intelligence.report", undefined, error); return null; }
}

function Filters({ allowed, selection, scope, view, window, productId }: {
  allowed: MarketId[]; selection: MarketId | "all"; scope: IntelligenceScope; view: IntelligenceView; window?: IntelligenceWindow;
  productId?: string;
}) {
  return <section className="commerce-panel intel-panel" aria-label="Report scope">
    <form action={storefrontPath(intelligencePath)} className="commerce-form">
      <input type="hidden" name="view" value={view} />
      <div className="commerce-fields">
        <label>Market<select name="market" defaultValue={selection}>
          {allowed.map(id => <option key={id} value={id}>{marketConfiguration(id).name}</option>)}
          {allowed.length > 1 && <option value="all">Compare markets</option>}
        </select></label>
        <label>Dataset<select name="scope" defaultValue={scope}>
          <option value="live">Production only</option><option value="test">Staging and test</option>
        </select></label>
        {view !== "drafts" && <>
          <label>From<input type="date" name="from" defaultValue={window?.from} /></label>
          <label>Through<input type="date" name="to" defaultValue={window?.to} /></label>
        </>}
      </div>
      {selection !== "all" && view !== "drafts" && <details open={productId ? true : undefined}><summary>Filter by catalog product ID</summary>
        <label>Product ID<input name="product" defaultValue={productId} maxLength={120} /></label>
      </details>}
      <button type="submit" className="button button--outline">Update scope</button>
    </form>
  </section>;
}

export default async function IntelligencePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const [params, allowed, merchandising, operations] = await Promise.all([
    searchParams, staffMarketIds(staff.id, "reporting"), staffMarketIds(staff.id, "merchandising"), staffMarketIds(staff.id, "operations"),
  ]);
  if (!allowed.length) notFound();
  const marketId = params.market === "all" ? "all" : params.market === undefined ? allowed[0] : params.market;
  if (marketId === "all" ? allowed.length < 2 : !isMarketId(marketId) || !allowed.includes(marketId)) notFound();
  const selected = marketId as MarketId | "all";
  const scope = params.scope === "test" ? "test" : "live";
  const test = scope === "test";
  const view = selected !== "all" && typeof params.view === "string" && Object.hasOwn(views, params.view) ? params.view as IntelligenceView : "overview";
  const get = (name: string, max = 120) => {
    const value = params[name];
    return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
  };
  const from = get("from", 10), to = get("to", 10);
  const productId = get("product");
  const variantFor = get("variantFor");
  const variantId = !variantFor || variantFor === productId ? get("variant") : undefined;
  const horizon = Number(get("horizon", 2));
  const horizonDays = Number.isInteger(horizon) && horizon >= 1 && horizon <= 56 ? horizon : 7;
  const now = new Date();
  const market = selected === "all" ? null : marketConfiguration(selected);
  const input = market ? { marketId: market.id, test, from, to, now,
    ...(view === "overview" && productId ? { productId, variantId } : {}) } : null;
  const [initialReport, comparison] = await Promise.all([
    input && view !== "drafts" ? readReport(input) : null,
    selected === "all" ? Promise.all(allowed.map(id => readReport({ marketId: id, test, from, to, now }))) : [],
  ]);
  const report = initialReport?.kind === "window-too-large" && view === "forecast" && input && productId
    ? await readReport({ ...input, productId }) : initialReport;
  const comparisonReports: ProductIntelligenceReport[] = comparison.flatMap(row => row?.kind === "report" ? [row] : []);
  const window = report?.window ?? comparisonReports[0]?.window;
  const permission = market && { actorId: staff.id, merchandising: merchandising.includes(market.id), operations: operations.includes(market.id) };
  return <div className="intelligence">
    <header className="intel-header"><h1 className="display-type">Product Intelligence</h1>
      <p>Evaluate what shoppers are looking for, where sales stall, and which products merit a stock or assortment decision.</p>
      <div className="intel-meta"><strong>{market?.name ?? "Authorized markets"}</strong>
        <span>{test ? "Staging fixtures and test evidence" : "Production evidence"}</span>
        {market && <span>{market.currency} · {market.timeZone}</span>}
        {window && market && <span>{window.from} – {window.to}</span>}
      </div>
    </header>
    <Filters allowed={allowed} selection={selected} scope={scope} window={window} view={view} productId={productId} />
    {market && <nav className="intel-tabs" aria-label="Product Intelligence views">{(Object.keys(views) as IntelligenceView[]).map(tab =>
      <Link className={`button button--${tab === view ? "primary" : "outline"}`} aria-current={tab === view ? "page" : undefined} key={tab}
        href={intelligenceUrl({ market: market.id, scope, view: tab, from: window?.from ?? from, to: window?.to ?? to,
          product: tab === "forecast" || tab === "analyst" ? productId : undefined,
          variant: tab === "forecast" || tab === "analyst" ? variantId : undefined, horizon: tab === "forecast" ? horizonDays : undefined })}>{views[tab]}</Link>)}</nav>}
    {selected === "all" && <Consolidated reports={comparisonReports} markets={allowed} test={test} />}
    {market && permission && view === "drafts" && <IntelligenceDrafts marketId={market.id} test={test} permission={permission} />}
    {market && view !== "drafts" && (!report || report.kind !== "report") && <p role="status" className="commerce-panel">
      {report ? "This selection exceeds the reporting limit. Choose a shorter date range or a product." : "Product evidence is temporarily unavailable."}
    </p>}
    {report?.kind === "report" && input && permission && view === "overview" &&
      <Overview report={report} permission={permission} assessments={await loadOpportunityAssessments(report, input)} />}
    {report?.kind === "report" && permission && view === "forecast" && await loadForecastBoard(report, {
      productId, variantId, authorizedMarkets: allowed, horizonDays, now,
    }).then(board => <ForecastBoard report={report} board={board} permission={permission} horizonDays={horizonDays} />).catch(error => {
      reportFailure("intelligence.forecast", undefined, error);
      return <p className="commerce-panel" role="status">Forecast evidence is temporarily unavailable.</p>;
    })}
    {report?.kind === "report" && market && view === "analyst" && <IntelligenceAnalyst key={`${market.id}:${scope}:${report.window.from}:${report.window.to}:${productId ?? ""}:${variantId ?? ""}`}
      market={market.id} marketName={market.name} test={test} from={report.window.from} to={report.window.to}
      choices={analystQuestions} product={productId} variant={variantId} />}
  </div>;
}
