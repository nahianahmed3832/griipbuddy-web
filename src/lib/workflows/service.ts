import { createHash } from "node:crypto";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { Prisma, type OperationalWorkflow } from "../../generated/prisma/client.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { staffMarketIds } from "../staff/market-access.ts";
import { OperationError } from "../staff/operations.ts";
import { workflowActionInputs } from "./action-input.ts";
import { effectiveWorkflowPolicy, policyForWorkflow, roleCanUseAction, workflowExecutionPolicy, workflowPolicies, type EffectiveWorkflowPolicy } from "./policy.ts";
import { workflowInput, workflowKey, workflowKinds, type ParsedWorkflowInput, type WorkflowAction, type WorkflowActor, type WorkflowReviewResult } from "./types.ts";

const day = 86_400_000;
const fail = (message: string): never => { throw new OperationError(message); };
const uuid = z.uuid();
const workflowIncludes = { job: true, events: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 40 },
  reviews: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 20 } } as const satisfies Prisma.OperationalWorkflowInclude;

function asJson(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export async function appendWorkflowEvent(db: DbReader, id: string, event: string, details: Prisma.InputJsonObject, actorId?: string, now = new Date()) {
  await db.operationalWorkflowEvent.create({ data: { workflowId: id, event, detail: details, actorId, createdAt: now } });
}

export async function lockWorkflowKey(db: DbReader, key: string) {
  await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${key}), 509)`;
}

export async function lockWorkflow(db: DbReader, id: string) {
  if (!uuid.safeParse(id).success) fail("Workflow unavailable.");
  await db.$queryRaw`SELECT id FROM "OperationalWorkflow" WHERE id = ${id}::uuid FOR UPDATE`;
  return db.operationalWorkflow.findUnique({ where: { id }, include: { job: true } });
}

export async function workflowAccess(db: DbReader, actor: WorkflowActor, marketId: MarketId, action: WorkflowAction, lock = false) {
  if (!roleCanUseAction(actor.agentRole ?? "STAFF", action) || actor.agentId !== undefined && (!actor.agentRole || !workflowKey.safeParse(actor.agentId).success)) return false;
  if (lock) {
    await db.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actor.staffId} FOR SHARE`;
    await db.$queryRaw`SELECT "userId" FROM "StaffMarketAccess" WHERE "userId" = ${actor.staffId} AND "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
  }
  const staff = await db.staffAccess.findUnique({ where: { userId: actor.staffId }, select: {
    active: true, role: true, marketGrants: { where: { marketId }, select: { merchandising: true, reporting: true, operations: true } },
  } });
  if (!staff?.active) return false;
  if (staff.role === "OWNER") return true;
  const [grant] = staff.marketGrants;
  if (!grant?.reporting) return false;
  if (action === "CONVERSION_TASK") return true;
  if (action === "PURCHASE_PROPOSAL") return grant.operations;
  return grant.merchandising;
}

export async function requireWorkflowActor(db: DbReader, actor: WorkflowActor, workflow: OperationalWorkflow, lock = false) {
  if (actor.agentRole && (actor.staffId !== workflow.ownerId || actor.agentRole !== workflow.agentRole) ||
    !await workflowAccess(db, actor, workflow.marketId, workflow.action, lock)) fail("Workflow unavailable to this account.");
}

function readInput(input: unknown) {
  const parsed = workflowInput.safeParse(input);
  if (!parsed.success) return fail("Use a valid workflow action, evidence, and review date.");
  if (!workflowActionInputs[parsed.data.action].safeParse(parsed.data.payload).success) return fail("The proposed action fields are invalid.");
  return parsed.data;
}

type BudgetIdentity = Pick<OperationalWorkflow, "test" | "budgetCurrency" | "budgetLedgerKey">;

function testCandidates(workflow: Pick<OperationalWorkflow, "action" | "payload">) {
  if (workflow.action !== "TEST_PLAN") return [];
  return workflowActionInputs.TEST_PLAN.safeParse(workflow.payload).data?.productIds ?? [];
}

export async function lockWorkflowResources(db: DbReader, workflow: Pick<OperationalWorkflow,
  "test" | "marketId" | "action" | "payload" | "resourceKey" | "budgetCurrency" | "budgetLedgerKey">) {
  const keys = [`workflow-resource:${workflow.test}:${workflow.resourceKey}`];
  for (const product of testCandidates(workflow)) keys.push(`workflow-test-candidate:${workflow.test}:${workflow.marketId}:${product}`);
  if (workflow.budgetLedgerKey) keys.push(`workflow-budget:${workflow.test}:${workflow.budgetCurrency}:${workflow.budgetLedgerKey}`);
  for (const key of [...new Set(keys)].sort()) await lockWorkflowKey(db, key);
}

export async function conflictingWorkflowResource(db: DbReader, workflow: Pick<OperationalWorkflow,
  "id" | "test" | "marketId" | "action" | "payload" | "resourceKey">) {
  const candidates = testCandidates(workflow);
  const overlap = candidates.length ? Prisma.sql`OR ("marketId" = ${workflow.marketId}::"MarketCode" AND action = 'TEST_PLAN'
    AND (payload->'productIds') ?| ARRAY[${Prisma.join(candidates)}]::text[])` : Prisma.empty;
  const [row] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "OperationalWorkflow" WHERE id <> ${workflow.id}::uuid AND test = ${workflow.test} AND "resourceHeld"
      AND ("resourceKey" = ${workflow.resourceKey} ${overlap}) LIMIT 1
  `;
  return Boolean(row);
}

async function ledgerUsage(db: DbReader, scope: BudgetIdentity, exceptId?: string) {
  const usage = await db.operationalWorkflow.aggregate({ where: { ...scope, ...(exceptId && { id: { not: exceptId } }) },
    _sum: { committedMinor: true, spentMinor: true } });
  return { committedMinor: usage._sum.committedMinor ?? 0, spentMinor: usage._sum.spentMinor ?? 0 };
}

export async function budgetBlockReason(db: DbReader,
  workflow: Pick<OperationalWorkflow, "id" | "test" | "budgetCurrency" | "budgetLedgerKey" | "budgetMinor">, policy: EffectiveWorkflowPolicy) {
  if (workflow.budgetMinor === null) return null;
  if (!policy.budget || !workflow.budgetCurrency || !workflow.budgetLedgerKey) return "A current budget ledger is unavailable.";
  const usage = await ledgerUsage(db, { test: workflow.test, budgetCurrency: workflow.budgetCurrency,
    budgetLedgerKey: workflow.budgetLedgerKey }, workflow.id);
  return usage.committedMinor + usage.spentMinor + workflow.budgetMinor > policy.budget.limitMinor
    ? "The remaining ledger budget is insufficient for this commitment." : null;
}

function resourceKey(input: ParsedWorkflowInput) {
  if (workflowKinds[input.action] === "HOMEPAGE") {
    if (!input.targetKey.startsWith(`homepage:${input.marketId}:`)) fail("Choose a market homepage resource.");
    return `homepage:${input.marketId}`;
  }
  if (input.action === "PURCHASE_PROPOSAL") {
    if (!input.targetKey.startsWith("inventory:")) fail("Choose a physical inventory pool.");
    return input.targetKey;
  }
  return `${input.marketId}:${input.action}:${input.targetKey}`;
}

function policyInput(input: ParsedWorkflowInput) {
  return { ...input, budgetMinor: input.budget?.minor ?? null, budgetCurrency: input.budget?.currency ?? null,
    budgetLedgerKey: input.budget?.ledgerKey ?? null };
}

export async function previewWorkflow(actor: WorkflowActor, input: unknown, now = new Date()) {
  const parsed = readInput(input);
  resourceKey(parsed);
  const db = getDb();
  if (!await workflowAccess(db, actor, parsed.marketId, parsed.action)) fail("Workflow unavailable to this account.");
  const policy = effectiveWorkflowPolicy({ marketId: parsed.marketId, test: parsed.test, action: parsed.action, role: actor.agentRole ?? "STAFF" });
  const decision = workflowExecutionPolicy(policyInput(parsed), policy, now);
  const reason = parsed.evidenceExpiresAt <= now ? "The evidence window is stale." : decision.allowed ? null : decision.reason;
  return { input: parsed, policy, reason, requiresReview: decision.allowed && decision.review };
}

export async function createWorkflow(actor: WorkflowActor, input: unknown, now = new Date()) {
  const parsed = readInput(input);
  const original = fingerprint({ input: parsed, ownerId: actor.staffId, role: actor.agentRole ?? "STAFF", agentId: actor.agentId });
  const resource = resourceKey(parsed);
  const { budget, evidence, payload, marketId, test, requestKey, ...fields } = parsed;
  return getDb().$transaction(async tx => {
    if (!await workflowAccess(tx, actor, marketId, fields.action, true)) fail("Workflow unavailable to this account.");
    const policy = effectiveWorkflowPolicy({ marketId, test, action: fields.action, role: actor.agentRole ?? "STAFF" });
    if (policy.mode === "RECOMMENDATION_ONLY") fail(policy.reason);
    await lockWorkflowKey(tx, `workflow-request:${marketId}:${test}:${requestKey}`);
    const existing = await tx.operationalWorkflow.findUnique({ where: { marketId_test_requestKey: { marketId, test, requestKey } } });
    if (existing) {
      if (existing.inputFingerprint !== original) fail("That request key is already attached to a different draft.");
      return existing;
    }
    if (fields.evidenceExpiresAt <= now || fields.evidenceExpiresAt.getTime() > +now + 180 * day) fail("Use a current evidence review window.");
    if (fields.outcomeReviewAt <= now || fields.outcomeReviewAt.getTime() > +now + 365 * day) fail("Choose a future outcome review date.");
    const workflow = await tx.operationalWorkflow.create({ data: { ...fields, marketId, test, requestKey, resourceKey: resource,
      ownerId: actor.staffId, agentRole: actor.agentRole, kind: workflowKinds[fields.action], inputFingerprint: original,
      policyVersion: policy.policyVersion, evidence: asJson(evidence), payload: asJson(payload),
      budgetMinor: budget?.minor, budgetCurrency: budget?.currency, budgetLedgerKey: budget?.ledgerKey, createdAt: now,
    } });
    await appendWorkflowEvent(tx, workflow.id, "DRAFT_CREATED", { policyVersion: policy.policyVersion, action: workflow.action,
      ...(actor.agentRole && { agentRole: actor.agentRole }), ...(actor.agentRole && actor.agentId && { agentId: actor.agentId }) }, actor.staffId, now);
    return workflow;
  });
}

export async function listWorkflows(staffId: string, filters: { marketIds?: readonly MarketId[]; test?: boolean } = {}) {
  const allowed = await staffMarketIds(staffId, "reporting");
  const markets = filters.marketIds ? allowed.filter(id => filters.marketIds!.includes(id)) : allowed;
  return getDb().operationalWorkflow.findMany({ where: { marketId: { in: markets }, test: filters.test },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
    include: { job: true, reviews: { orderBy: { createdAt: "desc" }, take: 1 } } });
}

export async function getWorkflow(staffId: string, id: string) {
  if (!uuid.safeParse(id).success) return null;
  const allowed = await staffMarketIds(staffId, "reporting");
  return getDb().operationalWorkflow.findFirst({ where: { id, marketId: { in: allowed } }, include: workflowIncludes });
}

export async function workflowLedgerBalances(staffId: string, filters: { marketIds?: readonly MarketId[]; test?: boolean } = {}) {
  const allowed = await staffMarketIds(staffId, "reporting");
  const markets = filters.marketIds ? allowed.filter(id => filters.marketIds!.includes(id)) : allowed;
  const { policies } = workflowPolicies();
  const ledgers = new Map<string, { policy: NonNullable<EffectiveWorkflowPolicy["budget"]>; test: boolean; markets: Set<MarketId> }>();
  for (const row of policies) {
    if (!row.budget || filters.test !== undefined && row.test !== filters.test) continue;
    const key = `${row.test}:${row.budget.ledgerKey}`;
    const value = ledgers.get(key) ?? { policy: row.budget, test: row.test, markets: new Set() };
    value.markets.add(row.marketId);
    ledgers.set(key, value);
  }
  const values = [...ledgers.values()].filter(entry => [...entry.markets].some(market => markets.includes(market)));
  return Promise.all(values.map(async ({ policy, test, markets }) => {
    const scopedMarkets = [...markets].filter(market => allowed.includes(market));
    const usage = scopedMarkets.length === markets.size ? await ledgerUsage(getDb(), { test, budgetLedgerKey: policy.ledgerKey, budgetCurrency: policy.currency }) : null;
    return { ledgerKey: policy.ledgerKey, currency: policy.currency, test, markets: scopedMarkets, validThrough: policy.validThrough,
      limitMinor: usage ? policy.limitMinor : null, committedMinor: usage?.committedMinor ?? null, spentMinor: usage?.spentMinor ?? null,
      remainingMinor: usage ? Math.max(0, policy.limitMinor - usage.committedMinor - usage.spentMinor) : null };
  }));
}

export async function holdReason(db: DbReader, workflow: OperationalWorkflow, reason: string, now: Date, actorId?: string) {
  if (workflow.blockReason === reason) return workflow;
  await appendWorkflowEvent(db, workflow.id, "BLOCKED", { reason, status: workflow.status }, actorId, now);
  return db.operationalWorkflow.update({ where: { id: workflow.id }, data: { blockReason: reason } });
}

export type WorkflowDecision = "ready" | "approve" | "cancel" | "retry" | "release";

export async function decideWorkflow(actor: WorkflowActor, id: string, decision: WorkflowDecision, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  return getDb().$transaction(async tx => {
    const workflow = await lockWorkflow(tx, id);
    if (!workflow) return fail("Workflow unavailable.");
    await requireWorkflowActor(tx, actor, workflow, true);
    if (decision === "cancel" || decision === "release") {
      if (decision === "release" && (workflow.status !== "COMPLETED" || !workflow.resourceHeld && !workflow.committedMinor)) return workflow;
      if (decision === "cancel" && workflow.status === "CANCELLED") return workflow;
      if (decision === "cancel" && !["DRAFT", "READY", "AWAITING_DECISION", "FAILED"].includes(workflow.status)) fail("This workflow cannot be cancelled now.");
      if (workflow.job && decision === "cancel") await tx.operationalWorkflowJob.update({ where: { workflowId: id }, data: { status: "CANCELLED", leaseToken: null, leaseUntil: null } });
      await appendWorkflowEvent(tx, id, decision === "cancel" ? "CANCELLED" : "RESERVATION_RELEASED", { releasedMinor: workflow.committedMinor }, actor.staffId, now);
      return tx.operationalWorkflow.update({ where: { id }, data: { ...(decision === "cancel" && { status: "CANCELLED" }), committedMinor: 0, resourceHeld: false } });
    }
    if (decision === "retry") {
      const job = workflow.job;
      if (workflow.status !== "READY" || job?.status !== "QUEUED" || !job.retryable || job.attempts >= job.maxAttempts) return fail("No bounded retry is pending.");
      await tx.operationalWorkflowJob.update({ where: { workflowId: id }, data: { availableAt: now } });
      await appendWorkflowEvent(tx, id, "RETRY_REQUESTED", { attempts: job.attempts }, actor.staffId, now);
      return workflow;
    }
    if (workflow.status === "READY" || workflow.status === "RUNNING") return workflow;
    if (decision === "approve" && (actor.agentRole || workflow.status !== "AWAITING_DECISION")) return fail("This workflow is not awaiting a staff decision.");
    if (!["DRAFT", "AWAITING_DECISION"].includes(workflow.status)) return fail("This workflow is no longer available for execution.");
    if (workflow.evidenceExpiresAt <= now) {
      await appendWorkflowEvent(tx, id, "EXPIRED", { reason: "The evidence window closed before queueing." }, actor.staffId, now);
      return tx.operationalWorkflow.update({ where: { id }, data: { status: "EXPIRED", blockReason: "The evidence window is stale." } });
    }
    const owner = { staffId: workflow.ownerId, agentRole: workflow.agentRole as WorkflowActor["agentRole"] };
    const policy = policyForWorkflow(workflow);
    if (!policy || !await workflowAccess(tx, owner, workflow.marketId, workflow.action, true)) {
      return holdReason(tx, workflow, "The workflow owner no longer has this market action permission.", now, actor.staffId);
    }
    const current = workflowExecutionPolicy(workflow, policy, now);
    if (!current.allowed) return holdReason(tx, workflow, current.reason, now, actor.staffId);
    if (decision === "approve" && workflow.policyVersion !== policy.policyVersion) {
      return holdReason(tx, workflow, "The policy changed. Submit again under the current policy.", now, actor.staffId);
    }
    if (current.review && decision === "ready") {
      if (workflow.status === "AWAITING_DECISION" && workflow.policyVersion === policy.policyVersion) return workflow;
      await appendWorkflowEvent(tx, id, "DECISION_REQUIRED", { policyVersion: policy.policyVersion }, actor.staffId, now);
      return tx.operationalWorkflow.update({ where: { id }, data: { status: "AWAITING_DECISION", policyVersion: policy.policyVersion, blockReason: "This action requires a staff decision under the current policy." } });
    }
    await lockWorkflowResources(tx, workflow);
    const conflict = await conflictingWorkflowResource(tx, workflow);
    if (conflict) return holdReason(tx, workflow, "This resource is already reserved by another workflow.", now, actor.staffId);
    const overBudget = await budgetBlockReason(tx, workflow, policy);
    if (overBudget) return holdReason(tx, workflow, overBudget, now, actor.staffId);
    const approved = decision === "approve";
    await tx.operationalWorkflowJob.create({ data: { workflowId: id, availableAt: now, maxAttempts: policy.maxAttempts } });
    const updated = await tx.operationalWorkflow.update({ where: { id }, data: { status: "READY", resourceHeld: true,
      committedMinor: workflow.budgetMinor ?? 0, blockReason: null, policyVersion: policy.policyVersion,
      approvedBy: approved ? actor.staffId : null, approvedPolicy: approved ? policy.policyVersion : null } });
    await appendWorkflowEvent(tx, id, "QUEUED", { policyVersion: policy.policyVersion, approved,
      committedMinor: updated.committedMinor, currency: workflow.budgetCurrency }, actor.staffId, now);
    return updated;
  });
}

export async function recordWorkflowReview(actor: WorkflowActor | null, id: string, input: WorkflowReviewResult, now = new Date()) {
  return getDb().$transaction(async tx => {
    const workflow = await lockWorkflow(tx, id);
    if (!workflow || workflow.status !== "COMPLETED" || workflow.outcomeReviewAt > now) return fail("The workflow outcome is not ready for review.");
    if (actor) await requireWorkflowActor(tx, actor, workflow, true);
    const result = await tx.operationalWorkflowReview.createMany({ skipDuplicates: true, data: {
      workflowId: id, reviewKey: input.reviewKey, outcome: input.outcome, evidence: input.evidence, createdAt: now,
    } });
    if (result.count) await appendWorkflowEvent(tx, id, "OUTCOME_REVIEWED", { outcome: input.outcome, reviewKey: input.reviewKey }, actor?.staffId, now);
    return tx.operationalWorkflowReview.findUnique({ where: { workflowId_reviewKey: { workflowId: id, reviewKey: input.reviewKey } } });
  });
}
