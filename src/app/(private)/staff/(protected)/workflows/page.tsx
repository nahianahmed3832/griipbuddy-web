import Link from "next/link";
import { notFound } from "next/navigation";
import { isMarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { prioritizeWorkflows, workflowManagerStatus, type WorkflowPriorityBudget } from "@/lib/workflows/manager";
import { workflowActions, workflowLabel, workflowStates, workflowUrl } from "@/lib/workflows/navigation";
import { listWorkflowPolicies, workflowPolicies } from "@/lib/workflows/policy";
import { listWorkflows, workflowLedgerBalances } from "@/lib/workflows/service";
import { IntelligenceTable, Scores } from "../intelligence/intelligence-ui";
import { workflowMoney } from "./workflow-ui";
import "../intelligence/intelligence.css";
import "./workflows.css";

export const metadata = { title: "Workflow Center", robots: { index: false, follow: false } };

export default async function WorkflowCenter({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const [params, allowed] = await Promise.all([searchParams, staffMarketIds(staff.id, "reporting")]);
  if (!allowed.length) notFound();
  const selected = params.market ?? (allowed.length > 1 ? "all" : allowed[0]);
  if (selected === "all" ? allowed.length < 2 : !isMarketId(selected) || !allowed.includes(selected)) notFound();
  const market = selected === "all" ? null : isMarketId(selected) ? marketConfiguration(selected) : null;
  const markets = market ? [market.id] : allowed;
  const test = params.scope === "test", scope = test ? "test" : "live";
  const policyView = params.view === "policy";
  const state = typeof params.state === "string" && Object.hasOwn(workflowStates, params.state) ? params.state : "";
  const [rows, balances] = await Promise.all([
    listWorkflows(staff.id, { marketIds: markets, test }), workflowLedgerBalances(staff.id, { marketIds: markets, test }),
  ]);
  const budgets: WorkflowPriorityBudget[] = balances.flatMap(balance => balance.markets.flatMap(marketId => balance.remainingMinor === null ? [] : [{
    marketId, test: balance.test, ledgerKey: balance.ledgerKey, currency: balance.currency, availableMinor: balance.remainingMinor, validThrough: balance.validThrough,
  }]));
  const ordered = prioritizeWorkflows(rows.filter(row => !state || row.status === state), budgets);
  const { agentBridge, listingHarness } = workflowManagerStatus();
  const policies = policyView ? listWorkflowPolicies(markets).filter(policy => policy.test === test) : [];
  const counts = rows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), {});
  return <div className="workflows">
    <header className="workflow-cover"><h1 className="display-type">Workflow Center</h1>
      <p>Turn market evidence into reviewed work, track what actually ran, and compare the result with the original hypothesis.</p>
      <div className="workflow-meta"><strong>{market?.name ?? "Authorized markets"}</strong><span>{test ? "Staging and fixture evidence" : "Production evidence"}</span></div>
      <div className="workflow-tools">{market && <Link href={workflowUrl({ market: market.id, scope }, "new")} className="button button--primary">Draft a workflow</Link>}
        <Link href={workflowUrl({ market: market?.id ?? "all", scope, view: policyView ? "queue" : "policy" })} className="button button--outline">
          {policyView ? "Prioritized queue" : "Execution policy"}</Link></div>
    </header>
    <section className="commerce-panel workflow-panel" aria-label="Workflow filters">
      <form className="commerce-form" action={storefrontPath(workflowUrl())}>
        <input type="hidden" name="view" value={policyView ? "policy" : "queue"} />
        <div className="commerce-fields"><label>Market<select name="market" defaultValue={market?.id ?? "all"}>
          {allowed.length > 1 && <option value="all">Authorized markets</option>}{allowed.map(id => <option value={id} key={id}>{marketConfiguration(id).name}</option>)}
        </select></label><label>Dataset<select name="scope" defaultValue={scope}><option value="live">Production</option><option value="test">Staging and test</option></select></label>
          {!policyView && <label>State<select name="state" defaultValue={state}><option value="">All states</option>
            {Object.entries(workflowStates).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>}
        </div><button className="button button--outline" type="submit">Update queue</button>
      </form>
    </section>
    <Scores entries={[{ label: "Ready to execute", value: counts.READY ?? 0 }, { label: "Awaiting decision", value: counts.AWAITING_DECISION ?? 0 },
      { label: "Running", value: counts.RUNNING ?? 0 }, { label: "Completed", value: counts.COMPLETED ?? 0 }]} />
    {policyView ? <section className="commerce-panel workflow-panel"><h2>Current execution policies</h2>
      <p>Staff and agents retain their existing market grants. A policy can allow a draft, permit automatic execution, or require review. Unconfigured actions have no execution authority.</p>
      {policies.length ? <IntelligenceTable label="Execution policies" columns={["Market", "Role", "Action", "Mode", "Version", "Maximum attempts", "Daily limit", "Automatic amount limit"]}>
        {policies.map(policy => <tr key={`${policy.marketId}/${policy.role}/${policy.action}`}><th scope="row">{marketConfiguration(policy.marketId).name}</th>
          <td>{workflowLabel({}, policy.role)}</td><td>{workflowActions[policy.action]}</td><td>{workflowLabel({}, policy.mode)}</td><td>{policy.version}</td>
          <td>{policy.maxAttempts}</td><td>{policy.maxRunsPerDay}</td><td>{policy.budget ? workflowMoney(policy.budget.automaticLimitMinor, policy.budget.currency) : "Unavailable"}</td></tr>)}
      </IntelligenceTable> : <p>{workflowPolicies().state === "invalid" ? "Policy configuration is invalid. Execution is unavailable." : "No execution policies for this selection."}</p>}
    </section> : <section className="commerce-panel workflow-panel"><h2>Prioritized work queue</h2>
      <p className="workflow-note">Priority uses recorded benefit, confidence, effort, eligible stock, and budget. It is an ordering aid.</p>
      {ordered.length ? <div>{ordered.map(({ workflow: row, priority }) => <article className="workflow-row" key={row.id}>
        <div><h3><Link href={workflowUrl({}, row.id)}>{row.title}</Link></h3><div className="workflow-meta">
          <strong>{marketConfiguration(row.marketId).name}</strong><span>{workflowActions[row.action]}</span><span>{priority.level} priority</span>
        </div><p className="workflow-note">{row.blockReason ?? row.expectedOutcome}</p>
          <details><summary>Why this priority</summary><ul>{priority.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></details></div>
        <div><span className="workflow-state">{workflowStates[row.status]}</span></div>
      </article>)}</div> : <p>No workflows match this market, dataset, and state.</p>}
    </section>}
    <section className="commerce-panel workflow-panel"><h2>Budget commitments and recorded spending</h2>
      {balances.length ? <IntelligenceTable label="Workflow budget ledgers" columns={["Ledger", "Markets", "Currency", "Limit", "Committed", "Spent", "Remaining", "Valid through"]}>
        {balances.map(row => <tr key={row.ledgerKey}><th scope="row">{row.ledgerKey}</th><td>{row.markets.map(id => marketConfiguration(id).name).join(", ")}</td>
          <td>{row.currency}</td><td>{workflowMoney(row.limitMinor, row.currency)}</td><td>{workflowMoney(row.committedMinor, row.currency)}</td>
          <td>{workflowMoney(row.spentMinor, row.currency)}</td><td>{workflowMoney(row.remainingMinor, row.currency)}</td><td>{row.validThrough}</td></tr>)}
      </IntelligenceTable> : <p>No authorized budget ledgers for this selection.</p>}
      <p className="workflow-note">Amounts stay in their recorded currency. Draft proposals and held budgets are separate from supplier orders and spend.</p>
    </section>
    <section className="commerce-panel workflow-panel"><h2>Manager and employee connections</h2>
      <p>Deterministic prioritization is available. Typed agent bridge {agentBridge}. Existing listing workforce connector {listingHarness}.</p>
    </section>
  </div>;
}
