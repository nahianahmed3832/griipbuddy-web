import Link from "next/link";
import { notFound } from "next/navigation";
import { WorkflowCommand, WorkflowCorrection } from "@/components/workflow-action-forms";
import { getDb } from "@/lib/db/client";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { intelligenceWorkflowEvidence } from "@/lib/workflows/evidence";
import { workflowListingHarnessLink } from "@/lib/workflows/listing-harness";
import { workflowActions, workflowLabel, workflowStates, workflowUrl } from "@/lib/workflows/navigation";
import { policyForWorkflow, workflowExecutionPolicy } from "@/lib/workflows/policy";
import { getWorkflow, workflowAccess } from "@/lib/workflows/service";
import { WorkflowDetails, workflowInternalHref, workflowMoney, workflowObject } from "../workflow-ui";
import "../workflows.css";

export const metadata = { title: "Workflow details", robots: { index: false, follow: false } };
type Work = NonNullable<Awaited<ReturnType<typeof getWorkflow>>>;

function commands(work: Work, now: Date) {
  const result: { value: string; label: string }[] = [];
  const add = (value: string, label: string) => result.push({ value, label });
  if (work.status === "DRAFT") add("ready", "Queue under current policy");
  if (work.status === "AWAITING_DECISION") { add("approve", "Approve execution"); add("ready", "Recheck decision requirement"); }
  if (["DRAFT", "AWAITING_DECISION", "READY"].includes(work.status)) add("dry-run", "Dry run");
  if (work.status === "READY" && work.job?.status === "QUEUED") {
    if (work.job.retryable && work.job.attempts < work.job.maxAttempts) add("retry", "Retry now");
    else if (work.job.availableAt <= now) add("run", "Run due job");
  }
  if (["DRAFT", "AWAITING_DECISION", "READY", "FAILED"].includes(work.status)) add("cancel", "Cancel workflow");
  if (work.status === "COMPLETED") {
    if (work.action === "HOME_DRAFT") add("publish", "Prepare publication");
    if (work.action === "HOME_PUBLISH") add("rollback", "Prepare rollback");
    if (work.resourceHeld || work.committedMinor) add("release", "Release commitment");
    if (work.outcomeReviewAt <= now) add("review", "Review outcome");
  }
  return result;
}

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  const work = await getWorkflow(staff.id, (await params).id);
  if (!work) notFound();
  const market = marketConfiguration(work.marketId);
  const scope = work.test ? "test" : "live";
  const clock = new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeStyle: "short", timeZone: market.timeZone });
  const now = new Date();
  const policy = policyForWorkflow(work);
  const permission = policy && workflowExecutionPolicy(work, policy, now);
  const payload = workflowObject(work.payload), record = workflowObject(work.result);
  const result = workflowObject(record.details), reference = workflowInternalHref(record.reference);
  const references = Array.isArray(work.evidence) ? work.evidence.map(workflowObject) : [];
  const [canAct, owner, harness, evidence] = await Promise.all([
    workflowAccess(getDb(), { staffId: staff.id }, work.marketId, work.action),
    getDb().user.findUnique({ where: { id: work.ownerId }, select: { name: true } }),
    work.action === "LISTING_DRAFT" && typeof payload.productId === "string" ? workflowListingHarnessLink(staff.id, work.marketId, payload.productId) : null,
    Promise.all(references.map(async item => {
      if (item.kind === "intelligence-draft" && typeof item.ref === "string") {
        const insight = await intelligenceWorkflowEvidence({ actorId: staff.id, draftId: item.ref });
        return insight?.marketId === work.marketId && insight.test === work.test ? { label: insight.title, href: insight.href, from: insight.from, to: insight.to } : null;
      }
      return item.kind === "workflow" && typeof item.ref === "string" && /^[0-9a-f-]{36}$/i.test(item.ref)
        ? { label: "Related workflow", href: workflowUrl({}, item.ref), from: undefined, to: undefined } : null;
    })),
  ]);
  return <div className="workflows">
    <header className="workflow-cover"><h1 className="display-type">{work.title}</h1>
      <div className="workflow-meta"><span className="workflow-state">{workflowStates[work.status]}</span><strong>{market.name}</strong>
        <span>{market.currency} · {work.test ? "Staging and fixture evidence" : "Production evidence"}</span><span>{workflowActions[work.action]}</span></div>
      <div className="workflow-tools"><Link href={workflowUrl({ market: market.id, scope })}>Back to Workflow Center</Link>
        {reference && <Link href={reference} className="button button--outline">{work.action === "HOME_DRAFT" ? "Preview homepage draft" : "Open execution record"}</Link>}
      </div>
    </header>
    <section className="commerce-panel workflow-panel"><h2>Evidence and proposed change</h2>
      <dl className="workflow-lexicon"><div><dt>Owner</dt><dd>{owner?.name ?? "Unavailable"}</dd></div>
        <div><dt>Agent role</dt><dd>{work.agentRole ? workflowLabel({}, work.agentRole) : "Staff"}</dd></div>
        <div><dt>Resource</dt><dd>{work.targetKey}</dd></div><div><dt>Outcome review</dt><dd>{clock.format(work.outcomeReviewAt)}</dd></div>
        <div><dt>Evidence expires</dt><dd>{clock.format(work.evidenceExpiresAt)}</dd></div></dl>
      <p><strong>Expected outcome</strong> {work.expectedOutcome}</p><p><strong>Uncertainty</strong> {work.uncertainty}</p>
      {evidence.some(Boolean) && <ul className="workflow-timeline">{evidence.map((item, index) => item && <li key={index}>
        <Link href={item.href}>{item.label}</Link>{item.from && item.to && ` · ${item.from} – ${item.to}`}</li>)}</ul>}
      <details><summary>Action parameters</summary><WorkflowDetails value={payload} /></details>
      {harness && <Link href={harness}>Open the existing listing workforce tool</Link>}
    </section>
    <section className="commerce-panel workflow-panel"><h2>Policy and decisions</h2>
      <dl className="workflow-lexicon"><div><dt>Recorded policy</dt><dd>{work.policyVersion}</dd></div>
        <div><dt>Current mode</dt><dd>{policy ? workflowLabel({}, policy.mode) : "Unavailable"}</dd></div><div><dt>Current policy</dt><dd>{policy?.policyVersion ?? "Unavailable"}</dd></div>
        <div><dt>Requested budget</dt><dd>{workflowMoney(work.budgetMinor, work.budgetCurrency)}</dd></div>
        <div><dt>Committed</dt><dd>{workflowMoney(work.committedMinor, work.budgetCurrency)}</dd></div>
        <div><dt>Recorded spend</dt><dd>{workflowMoney(work.spentMinor, work.budgetCurrency)}</dd></div></dl>
      {work.blockReason && <p role="status">{work.blockReason}</p>}
      {permission && !permission.allowed && work.status !== "COMPLETED" && <p className="workflow-note">{permission.reason}</p>}
      {canAct && <WorkflowCommand id={work.id} commands={commands(work, now)} />}
      {canAct && work.action === "CONVERSION_TASK" && work.status === "COMPLETED" && result.changeApplied === false &&
        <details><summary>Link an applied correction</summary><WorkflowCorrection id={work.id}/></details>}
    </section>
    <section className="commerce-panel workflow-panel"><h2>Execution and audit history</h2>
      {work.job ? <dl className="workflow-lexicon"><div><dt>Job state</dt><dd>{workflowLabel({}, work.job.status)}</dd></div>
        <div><dt>Attempts</dt><dd>{work.job.attempts} / {work.job.maxAttempts}</dd></div>
        <div><dt>Next eligible attempt</dt><dd>{work.job.status === "QUEUED" ? clock.format(work.job.availableAt) : "—"}</dd></div>
        <div><dt>Recorded failure</dt><dd>{work.job.lastError ?? "—"}</dd></div></dl>
        : <p>No execution job has been accepted yet.</p>}
      {work.completedAt && <p>Execution recorded {clock.format(work.completedAt)}.</p>}
      {Object.keys(result).length > 0 && <details open><summary>Verified execution result</summary><WorkflowDetails value={result} /></details>}
      <ol className="workflow-timeline">{work.events.map(event => <li key={event.id}>
        <strong>{workflowLabel({}, event.event)}</strong> · <time dateTime={event.createdAt.toISOString()}>{clock.format(event.createdAt)}</time>
        <details><summary>Audit details</summary><WorkflowDetails value={workflowObject(event.detail)} /></details></li>)}</ol>
    </section>
    <section className="commerce-panel workflow-panel"><h2>Observed outcomes</h2>
      {!work.reviews.length && <p>{now < work.outcomeReviewAt ? `Review opens ${clock.format(work.outcomeReviewAt)}.` : "No evaluated outcome is recorded yet."}</p>}
      {work.reviews.map(review => {
        const { reason, ...data } = workflowObject(review.evidence), href = workflowInternalHref(data.source);
        const experiment = workflowObject(data.experiment), experimentHref = workflowInternalHref(experiment.source);
        return <article className="workflow-panel" key={review.id}><h3>{workflowLabel({}, review.outcome)}</h3>
          <p>{typeof reason === "string" ? reason : "Evidence recorded."}</p>
          <p className="workflow-note">{clock.format(review.createdAt)} · {data.causal === true ? "Causal evidence available" : "Observational evidence"}</p>
          <WorkflowDetails value={data} />{typeof experiment.pendingUntil === "string" && <p>Fulfillment and collections evidence is pending through {clock.format(new Date(experiment.pendingUntil))}.</p>}
          {href && <Link href={href}>Open supporting report</Link>}
          {experimentHref && <Link href={experimentHref}>Open experiment and follow-up windows</Link>}</article>;
      })}
    </section>
  </div>;
}
