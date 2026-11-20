import Link from "next/link";
import { notFound } from "next/navigation";
import { isMarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { WorkflowIntakeForm } from "@/components/workflow-action-forms";
import { draftDay, draftEvidenceInput, listIntelligenceDrafts } from "@/lib/intelligence/drafts";
import { intelligenceUrl } from "@/lib/intelligence/navigation";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { workflowActions, workflowUrl } from "@/lib/workflows/navigation";
import { effectiveWorkflowPolicy } from "@/lib/workflows/policy";
import { defaultOutcomeDay, workflowInsight, workflowIntakeActions, type IntakeAction } from "@/lib/workflows/staff-intake";
import "../workflows.css";

export const metadata = { title: "Draft a workflow", robots: { index: false, follow: false } };

function ActionFields({ action, market, product, title }: {
  action: IntakeAction; market: ReturnType<typeof marketConfiguration>; product?: string; title: string;
}) {
  if (action === "HOME_DRAFT") return <>
    <div className="commerce-fields">
      <label>Locale<select name="locale" defaultValue={market.defaultLocale}>{market.languages.map(locale => <option key={locale}>{locale}</option>)}</select></label>
      <label>Homepage change<select name="rankingPlacement" defaultValue=""><option value="">Curated collection</option><option value="recommended">Recommended placement boost</option></select></label>
      <label>Section title<input name="sectionTitle" required maxLength={90} defaultValue={title.slice(0, 90)} /></label>
    </div>
    <label>Product IDs<input name="productIds" required maxLength={1200} defaultValue={product} /></label>
    <div className="commerce-fields"><label>Starts locally<input type="datetime-local" name="startsLocal" /></label>
      <label>Ends locally<input type="datetime-local" name="endsLocal" /></label></div>
    <p className="workflow-note">Use {market.timeZone} for scheduled collections. Ranking changes stay unscheduled.</p>
  </>;
  if (action === "TEST_PLAN") return <>
    <label>Product IDs<input name="productIds" required maxLength={1200} defaultValue={product} /></label>
    <p>Audience · Eligible visitors in {market.name}</p>
    <div className="commerce-fields">
      <label>Minimum stock<input type="number" name="minimumStock" defaultValue={2} min={1} max={100000} required /></label>
      <label>Duration (days)<input type="number" name="durationDays" defaultValue={7} min={1} max={56} required /></label>
      <label>Success metric<select name="successMetric"><option value="verified-paid-orders">Verified paid or collected orders</option><option value="product-to-cart">Measured view-to-cart journeys</option></select></label>
      <label>Success threshold<input type="number" name="successThreshold" defaultValue={5} min={1} required /></label>
    </div>
    <label>Stopping rule<input name="stoppingRule" required maxLength={300} defaultValue="Stop if eligible stock falls below the planned minimum." /></label>
  </>;
  if (action === "PURCHASE_PROPOSAL") return <p>The worker recalculates the proposal from the current forecast, physical stock and dated purchasing inputs. Submission to a supplier is a separate operation.</p>;
  if (action === "CONVERSION_TASK") return <>
    <div className="commerce-fields"><label>Investigation area<select name="area"><option value="funnel">Funnel</option><option value="payment">Payment</option><option value="search">Search</option></select></label>
      <label>Outcome metric<select name="successMetric" defaultValue=""><option value="">Describe findings only</option>
        <option value="product-to-cart">View-to-cart journeys</option><option value="payment-failures">Verified payment failures</option><option value="zero-result-searches">Zero-result searches</option></select></label>
      <label>Success threshold<input type="number" name="successThreshold" min={0} max={1000000} /></label></div>
    <label>Corrective change to investigate<input name="correctiveChange" maxLength={400} /></label>
    <p className="workflow-note">The evidence snapshot separates observed facts from the suggested cause. Customer details and recording URLs stay outside the task.</p>
  </>;
  return <>
    <p>Product · {product}</p>
    <label>Proposed product name<input name="listingName" maxLength={120} /></label>
    <label>Proposed short description<input name="shortDescription" maxLength={300} /></label>
  </>;
}

export default async function NewWorkflow({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const [params, markets] = await Promise.all([searchParams, staffMarketIds(staff.id, "reporting")]);
  const insight = await workflowInsight(staff.id, params.draft);
  if (params.draft !== undefined && !insight) notFound();
  const marketId = insight?.market.id ?? (params.market === undefined ? markets[0] : params.market);
  if (!isMarketId(marketId) || !markets.includes(marketId) || params.market !== undefined && params.market !== marketId) notFound();
  const market = marketConfiguration(marketId);
  const test = insight?.source.test ?? params.scope === "test", scope = test ? "test" : "live";
  const sources = insight ? [] : await listIntelligenceDrafts(staff.id, marketId, test);
  const allowed = insight ? await workflowIntakeActions(staff.id, marketId, insight.source) : [];
  const action = allowed.find(candidate => candidate === params.action) ?? allowed[0];
  const policy = action ? effectiveWorkflowPolicy({ marketId, test, role: "STAFF", action }) : null;
  const source = insight?.source;
  const budgetAction = action === "PURCHASE_PROPOSAL" || action === "TEST_PLAN";
  return <div className="workflows">
    <header className="workflow-cover"><h1 className="display-type">Draft a workflow</h1>
      <p className="workflow-meta">{market.name} · {market.currency} · {test ? "Staging and fixture evidence" : "Production evidence"}</p>
      <Link href={workflowUrl({ market: marketId, scope })}>Workflow Center</Link>
    </header>
    {!source && <section className="commerce-panel workflow-panel"><h2>Choose a saved insight</h2>
      {sources.length ? <form className="commerce-form" action={storefrontPath(workflowUrl({}, "new"))}>
        <input type="hidden" name="market" value={marketId} /><input type="hidden" name="scope" value={scope} />
        <label>Saved insight<select name="draft">{sources.map(record => {
          const parsed = draftEvidenceInput.safeParse(record.evidence);
          return parsed.success ? <option key={record.id} value={record.id}>{parsed.data.title} · {draftDay(record.through)}</option> : null;
        })}</select></label>
        <button type="submit" className="button button--primary">Use insight</button>
      </form> : <p>Save an evidence-backed draft in Product Intelligence to start a workflow.</p>}
      <Link href={intelligenceUrl({ market: marketId, scope })}>Open Product Intelligence</Link>
    </section>}
    {source && <section className="commerce-panel workflow-panel"><h2>{source.title}</h2>
      <p className="workflow-meta">Evidence window {source.from} – {source.to}</p>
      <ul className="workflow-timeline">{source.facts.map((item, offset) => <li key={offset}>{item}</li>)}</ul>
      <Link href={source.href}>Open the evidence</Link>
    </section>}
    {source && action && policy && <section className="commerce-panel workflow-panel"><h2>Proposed action</h2>
      <nav className="workflow-tools" aria-label="Workflow types">{allowed.map(item => <Link key={item} href={workflowUrl({ market: marketId, scope,
        draft: source.draftId, action: item }, "new")} className={`button button--${item === action ? "primary" : "outline"}`}
        aria-current={item === action ? "page" : undefined}>{workflowActions[item]}</Link>)}</nav>
      <p className="workflow-note">{policy.mode.toLowerCase().replaceAll("_", " ")} · {policy.reason}</p>
      <WorkflowIntakeForm>
        <input type="hidden" name="draft" value={source.draftId} /><input type="hidden" name="action" value={action} />
        <label>Workflow title<input name="title" defaultValue={source.title.slice(0, 160)} maxLength={160} required /></label>
        <ActionFields action={action} market={market} product={source.productId} title={source.title} />
        {action === "TEST_PLAN" && <label>Requested budget in {market.currency} minor units<input name="budgetMinor" type="number" min={1} max={999999999} /></label>}
        {budgetAction && <p className="workflow-note">{policy.budget ? `Ledger ${policy.budget.ledgerKey} applies. The worker verifies current commitments.` : "No current budget authority is configured."}</p>}
        <label>Expected outcome<input name="expectedOutcome" defaultValue={source.hypothesis.slice(0, 500)} maxLength={500} required /></label>
        <label>Uncertainty<input name="uncertainty" maxLength={400} required defaultValue={test ? "Synthetic evidence for staged review." : undefined} /></label>
        <div className="commerce-fields">
          <label>Outcome review date<input type="date" name="reviewOn" defaultValue={defaultOutcomeDay(marketId)} required /></label>
          <label>Relative benefit (0–100)<input name="benefit" type="number" min={0} max={100} /></label>
          <label>Confidence (0–100)<input name="confidence" type="number" min={0} max={100} /></label>
          <label>Effort estimate (hours)<input name="effort" type="number" min={1} max={100} /></label>
        </div>
        <label className="commerce-option"><input type="checkbox" name="queue" /> Submit for execution under the current policy</label>
      </WorkflowIntakeForm>
    </section>}
    {source && !action && <p className="commerce-panel">Your market permissions allow reading this insight. Workflow creation requires the corresponding operating grant.</p>}
  </div>;
}
