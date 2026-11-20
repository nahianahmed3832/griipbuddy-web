import "../../scripts/load-env.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../../src/lib/market-calendar.ts";
import { appendWorkflowEvent, createWorkflow, decideWorkflow, getWorkflow, listWorkflows, recordWorkflowReview, workflowLedgerBalances } from "../../src/lib/workflows/service.ts";
import { dryRunWorkflow, runNextWorkflow, sweepWorkflowLifecycle } from "../../src/lib/workflows/worker.ts";
import type { WorkflowAdapters, WorkflowInput } from "../../src/lib/workflows/types.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const actor = { staffId: (await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" }, select: { userId: true } })).userId };
const prefix = `engine-${randomUUID()}`;
const clock = new Date();
const afterMs = (ms: number) => new Date(+clock + ms);
const ledgers = { bd: `${prefix}:BD`, us: `${prefix}:US` };
const currencies = { bd: "BDT", us: "USD" } as const;
const environment = process.env.GRIIP_WORKFLOW_POLICY;
const budgetPolicy = (marketId: "bd" | "us", limitMinor: number, automaticLimitMinor: number) => ({ ledgerKey: ledgers[marketId],
  currency: currencies[marketId], limitMinor, automaticLimitMinor, validThrough: "2099-12-31" });

function installPolicy() {
  process.env.GRIIP_WORKFLOW_POLICY = JSON.stringify([
    { marketId: "bd", test: true, role: "STAFF", action: "CONVERSION_TASK", mode: "AUTOMATIC", version: "workflow-test", maxAttempts: 2 },
    { marketId: "us", test: true, role: "STAFF", action: "CONVERSION_TASK", mode: "AUTOMATIC", version: "workflow-test", maxAttempts: 2 },
    { marketId: "bd", test: true, role: "STAFF", action: "PURCHASE_PROPOSAL", mode: "AUTOMATIC", version: "workflow-test", budget: budgetPolicy("bd", 100, 80) },
    { marketId: "us", test: true, role: "STAFF", action: "PURCHASE_PROPOSAL", mode: "AUTOMATIC", version: "workflow-test", budget: budgetPolicy("us", 120, 120) },
    { marketId: "bd", test: true, role: "STAFF", action: "TEST_PLAN", mode: "AUTOMATIC", version: "workflow-test", budget: budgetPolicy("bd", 100, 80) },
  ]);
}

function conversion(suffix: string, marketId: "bd" | "us" = "bd"): WorkflowInput {
  return { marketId, test: true, action: "CONVERSION_TASK", targetKey: `conversion:${marketId}:funnel:${prefix}-${suffix}`,
    title: "Fixture conversion issue", expectedOutcome: "Recheck the affected section", uncertainty: "Synthetic dataset, causal impact unavailable",
    outcomeReviewAt: afterMs(45_000), evidenceExpiresAt: afterMs(180_000), evidence: [{ kind: "fixture", ref: suffix }],
    payload: { area: "funnel", facts: ["fixture funnel observation"], hypotheses: ["fixture proposed cause"] }, requestKey: `${prefix}-${suffix}` };
}

function purchase(suffix: string, minor: number, marketId: "bd" | "us" = "bd", pool = suffix): WorkflowInput {
  return { ...conversion(suffix, marketId), action: "PURCHASE_PROPOSAL", targetKey: `inventory:${prefix}:${pool}`,
    payload: { draftId: "a".repeat(64) }, budget: { ledgerKey: ledgers[marketId], currency: currencies[marketId], minor } };
}

function plan(suffix: string, candidates: string[]): WorkflowInput {
  return { ...conversion(suffix), action: "TEST_PLAN", targetKey: `test:bd:${candidates[0]}`, payload: {
    productIds: candidates, audience: "eligible-market-visitors", minimumStock: 30, durationDays: 7, successMetric: "verified-paid-orders",
    successThreshold: 3, stoppingRule: "Stop when an eligibility check fails.",
  }, budget: { ledgerKey: ledgers.bd, currency: "BDT", minor: 1 } };
}

const mock: WorkflowAdapters = {
  CONVERSION_TASK: { validate: async () => ({ ok: true }), execute: async ({ idempotencyKey }) => ({ details: { idempotencyKey } }) },
  PURCHASE_PROPOSAL: { validate: async () => ({ ok: true }), execute: async () => ({ details: { placed: false } }) },
};

after(async () => {
  if (environment === undefined) delete process.env.GRIIP_WORKFLOW_POLICY;
  else process.env.GRIIP_WORKFLOW_POLICY = environment;
  const rows = await db.operationalWorkflow.findMany({ where: { requestKey: { startsWith: prefix } }, select: { id: true } });
  const keys = { workflowId: { in: rows.map(row => row.id) } };
  await db.operationalWorkflowReview.deleteMany({ where: keys });
  await db.operationalWorkflowEvent.deleteMany({ where: keys });
  await db.operationalWorkflowJob.deleteMany({ where: keys });
  await db.operationalWorkflow.deleteMany({ where: { requestKey: { startsWith: prefix } } });
  await db.$disconnect();
});

test("permission boundaries, dry-run, idempotency, concurrent claim, and dated review", async () => {
  installPolicy();
  const staffId = randomUUID();
  await db.user.create({ data: { id: staffId, name: "Workflow fixture analyst", email: `${staffId}@example.test`,
    staff: { create: { role: "PACKER", marketGrants: { create: { marketId: "bd", reporting: true } } } } } });
  try {
    const source = conversion("single");
    const [one, two] = await Promise.all([createWorkflow(actor, source, clock), createWorkflow(actor, source, clock)]);
    assert.equal(one.id, two.id);
    await assert.rejects(createWorkflow(actor, { ...source, title: "Different input for a used key" }, clock), /request key/);
    assert.equal((await dryRunWorkflow(actor, one.id, mock, clock)).canQueue, true);
    const before = await getWorkflow(actor.staffId, one.id);
    assert.equal(before?.events.length, 1);
    assert.equal(before?.job, null);
    await assert.rejects(createWorkflow({ staffId }, conversion("denied-us", "us"), clock), /unavailable to this account/);
    await assert.rejects(createWorkflow({ staffId }, purchase("denied-purchase", 1), clock), /unavailable to this account/);
    await assert.rejects(createWorkflow({ staffId: actor.staffId, agentRole: "BUYER" }, source, clock), /unavailable to this account/);
    const hidden = await createWorkflow(actor, conversion("other-market", "us"), clock);
    assert.equal(await getWorkflow(staffId, hidden.id), null);
    assert.deepEqual(await listWorkflows(staffId, { marketIds: ["us"] }), []);
    assert.equal((await decideWorkflow(actor, one.id, "ready", { now: clock })).status, "READY");
    await Promise.all([
      runNextWorkflow({ adapters: mock, workflowId: one.id, workerId: "first", now: clock }),
      runNextWorkflow({ adapters: mock, workflowId: one.id, workerId: "second", now: clock }),
    ]);
    const saved = await getWorkflow(actor.staffId, one.id);
    assert.equal(saved?.status, "COMPLETED");
    assert.equal(saved?.job?.attempts, 1);
    assert.equal(saved.events.filter(event => event.event === "COMPLETED").length, 1);
    const result = { reviewKey: "fixture-window", outcome: "INCONCLUSIVE" as const, evidence: { fixture: true } };
    await assert.rejects(recordWorkflowReview(actor, one.id, result, clock), /not ready/);
    await Promise.all([recordWorkflowReview(actor, one.id, result, afterMs(45_000)), recordWorkflowReview(actor, one.id, result, afterMs(45_000))]);
    assert.equal((await getWorkflow(actor.staffId, one.id))?.reviews.length, 1);
  } finally { await db.user.delete({ where: { id: staffId } }); }
});

test("concurrent budget and resource commitments remain bounded across markets", async () => {
  installPolicy();
  const inputs = [purchase("shared-first", 60, "bd", "shared"), purchase("other-budget", 60), purchase("needs-review", 90),
    purchase("shared-us", 25, "us", "shared")];
  const [primary, competing, review, us] = await Promise.all(inputs.map(input => createWorkflow(actor, input, clock)));
  const [a, b] = await Promise.all([decideWorkflow(actor, primary.id, "ready", { now: clock }), decideWorkflow(actor, competing.id, "ready", { now: clock })]);
  assert.equal([a, b].filter(row => row.status === "READY").length, 1);
  const blocked = [a, b].find(row => row.status === "DRAFT")!;
  assert.match(blocked.blockReason!, /remaining ledger/);
  assert.equal((await decideWorkflow(actor, review.id, "ready", { now: clock })).status, "AWAITING_DECISION");
  assert.match((await decideWorkflow(actor, review.id, "approve", { now: clock })).blockReason!, /remaining ledger/);
  const queued = [a, b].find(row => row.status === "READY")!;
  if (queued.id !== primary.id) {
    await decideWorkflow(actor, queued.id, "cancel", { now: clock });
    await decideWorkflow(actor, primary.id, "ready", { now: clock });
  }
  assert.equal((await runNextWorkflow({ adapters: mock, workflowId: primary.id, now: clock }))?.status, "COMPLETED");
  assert.match((await decideWorkflow(actor, us.id, "ready", { now: clock })).blockReason!, /already reserved/);
  const balances = await workflowLedgerBalances(actor.staffId, { marketIds: ["bd", "us"], test: true });
  assert.deepEqual(balances.map(row => [row.currency, row.committedMinor, row.spentMinor, row.remainingMinor]).sort(),
    [["BDT", 60, 0, 40], ["USD", 0, 0, 120]]);
  await decideWorkflow(actor, primary.id, "release", { now: clock });
  assert.equal((await decideWorkflow(actor, us.id, "ready", { now: clock })).status, "READY");
  await decideWorkflow(actor, us.id, "cancel", { now: clock });
  assert.equal((await decideWorkflow(actor, review.id, "approve", { now: clock })).status, "READY");
  await decideWorkflow(actor, review.id, "cancel", { now: clock });
  const [firstPlan, secondPlan] = await Promise.all([createWorkflow(actor, plan("overlap-a", ["p-a", "p-b"]), clock), createWorkflow(actor, plan("overlap-b", ["p-b", "p-c"]), clock)]);
  const overlap = await Promise.all([decideWorkflow(actor, firstPlan.id, "ready", { now: clock }), decideWorkflow(actor, secondPlan.id, "ready", { now: clock })]);
  assert.equal(overlap.filter(row => row.status === "READY").length, 1);
  assert.match(overlap.find(row => row.status === "DRAFT")!.blockReason!, /already reserved/);
});

test("lease recovery, failed transaction rollback, bounded retry, and stale evidence", async () => {
  installPolicy();
  const lingering = await createWorkflow(actor, conversion("recovery"), clock);
  await decideWorkflow(actor, lingering.id, "ready", { now: clock });
  await db.$transaction(async tx => {
    await tx.operationalWorkflow.update({ where: { id: lingering.id }, data: { status: "RUNNING" } });
    await tx.operationalWorkflowJob.update({ where: { workflowId: lingering.id }, data: { status: "LEASED", attempts: 1, leaseToken: randomUUID(),
      leaseUntil: afterMs(-500), workerId: "terminated-worker" } });
  });
  assert.equal((await runNextWorkflow({ adapters: mock, workflowId: lingering.id, now: clock }))?.status, "COMPLETED");
  assert.ok((await getWorkflow(actor.staffId, lingering.id))?.events.some(event => event.event === "LEASE_RECOVERED"));

  const transient = await createWorkflow(actor, conversion("rollback"), clock);
  await decideWorkflow(actor, transient.id, "ready", { now: clock });
  const failing = { CONVERSION_TASK: { validate: async () => ({ ok: true as const }), execute: async ({ tx, workflow }: Parameters<NonNullable<WorkflowAdapters["CONVERSION_TASK"]>["execute"]>[0]) => {
    await appendWorkflowEvent(tx, workflow.id, "UNCOMMITTED", {});
    throw new Error("fixture simulated process failure");
  } } };
  assert.equal((await runNextWorkflow({ adapters: failing, workflowId: transient.id, now: clock }))?.status, "READY");
  assert.equal(await runNextWorkflow({ adapters: failing, workflowId: transient.id, now: afterMs(500) }), null);
  await decideWorkflow(actor, transient.id, "retry", { now: afterMs(500) });
  assert.equal((await runNextWorkflow({ adapters: failing, workflowId: transient.id, now: afterMs(500) }))?.status, "FAILED");
  await assert.rejects(decideWorkflow(actor, transient.id, "retry", { now: afterMs(500) }), /No bounded retry/);
  const failed = await getWorkflow(actor.staffId, transient.id);
  assert.equal(failed?.job?.attempts, 2);
  assert.equal(failed?.events.some(event => event.event === "UNCOMMITTED"), false);
  const stale = await createWorkflow(actor, { ...conversion("stale"), evidenceExpiresAt: afterMs(20_000) }, clock);
  await decideWorkflow(actor, stale.id, "ready", { now: clock });
  assert.equal((await runNextWorkflow({ adapters: mock, workflowId: stale.id, now: afterMs(40_000) }))?.status, "EXPIRED");
  const archived = await createWorkflow(actor, { ...conversion("stale-draft"), evidenceExpiresAt: afterMs(5000) }, clock);
  assert.equal(await sweepWorkflowLifecycle({ workflowId: archived.id, now: afterMs(10_000) }), 1);
  assert.equal((await getWorkflow(actor.staffId, archived.id))?.status, "EXPIRED");
});

test("agent execution cap uses the market day and does not spend the retry allowance", async () => {
  process.env.GRIIP_WORKFLOW_POLICY = JSON.stringify([{ marketId: "bd", test: true, role: "ANALYST", action: "CONVERSION_TASK",
    mode: "AUTOMATIC", version: "market-day-test", maxRunsPerDay: 1 }]);
  const agent = { staffId: actor.staffId, agentRole: "ANALYST" as const, agentId: "fixture-agent" };
  const day = 86_400_000;
  const timeZone = "Asia/Dhaka";
  const tomorrow = marketDayStart(shiftCalendarDay(marketDay(clock, timeZone), 1)!, timeZone)!;
  const [first, second] = await Promise.all(["cap-first", "cap-second"].map(suffix => createWorkflow(agent, {
    ...conversion(suffix), evidenceExpiresAt: afterMs(2 * day), outcomeReviewAt: afterMs(3 * day),
  }, clock)));
  const created = await getWorkflow(actor.staffId, first.id);
  assert.equal((created?.events[0].detail as { agentId: string } | undefined)?.agentId, agent.agentId);
  await Promise.all([decideWorkflow(agent, first.id, "ready", { now: clock }), decideWorkflow(agent, second.id, "ready", { now: clock })]);
  const results = await Promise.all([first, second].map(row => runNextWorkflow({ adapters: mock, workflowId: row.id, now: clock })));
  assert.equal(results.filter(result => result?.status === "COMPLETED").length, 1);
  const deferred = results.find(result => result?.status === "READY");
  assert.ok(deferred);
  assert.equal(deferred.retryAt?.toISOString(), tomorrow.toISOString());
  assert.equal((await getWorkflow(actor.staffId, deferred.workflowId))?.job?.attempts, 0);
  assert.equal((await runNextWorkflow({ adapters: mock, workflowId: deferred.workflowId, now: tomorrow }))?.status, "COMPLETED");
});
