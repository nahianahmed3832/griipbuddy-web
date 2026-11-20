import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { Prisma, type OperationalWorkflow, type OperationalWorkflowJob } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { reportFailure } from "../db/observability.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { OperationError } from "../staff/operations.ts";
import { policyForWorkflow, workflowExecutionPolicy, type EffectiveWorkflowPolicy } from "./policy.ts";
import { appendWorkflowEvent, budgetBlockReason, conflictingWorkflowResource, lockWorkflow, lockWorkflowKey, lockWorkflowResources, recordWorkflowReview, requireWorkflowActor, workflowAccess } from "./service.ts";
import { minorUnits, workflowText, type WorkflowActor, type WorkflowAdapters, type WorkflowEvaluator, type WorkflowResult } from "./types.ts";

const options = { timeout: 20_000, maxWait: 8_000 };
const leaseMs = 90_000;
const day = 86_400_000;
const workerIdentity = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:@/-]+$/);
const safeReason = (reason: unknown, fallback: string) => workflowText(500).safeParse(reason).data ?? fallback;
const executionKey = (workflow: OperationalWorkflow) => `workflow:${workflow.id}:${workflow.action}`;

type WorkerFilters = { workflowId?: string; marketIds?: readonly MarketId[]; test?: boolean };
type WorkerOptions = WorkerFilters & { adapters: WorkflowAdapters; workerId?: string; now?: Date };
type Claimed = { kind: "claimed"; workflowId: string; leaseToken: string };
type WorkerResult = { kind: "processed"; workflowId: string; status: OperationalWorkflow["status"]; retryAt?: Date };
type JobWorkflow = OperationalWorkflow & { job: OperationalWorkflowJob | null };

const scoped = (filters: WorkerFilters) => Prisma.sql`
  ${filters.workflowId ? Prisma.sql`AND w.id = ${filters.workflowId}::uuid` : Prisma.empty}
  ${filters.marketIds ? Prisma.sql`AND w."marketId"::text IN (${Prisma.join(filters.marketIds)})` : Prisma.empty}
  ${filters.test === undefined ? Prisma.empty : Prisma.sql`AND w.test = ${filters.test}`}
`;

export async function dryRunWorkflow(actor: WorkflowActor, id: string, adapters: WorkflowAdapters, now = new Date()) {
  return getDb().$transaction(async tx => {
    const workflow = await lockWorkflow(tx, id);
    if (!workflow) throw new OperationError("Workflow unavailable.");
    await requireWorkflowActor(tx, actor, workflow);
    const policy = policyForWorkflow(workflow);
    const decision = policy && workflowExecutionPolicy(workflow, policy, now);
    const adapter = adapters[workflow.action];
    const eligibility = workflow.evidenceExpiresAt <= now ? { ok: false as const, reason: "The evidence window is stale." }
      : !adapter ? { ok: false as const, reason: "The action adapter is unavailable." }
        : await adapter.validate({ tx, workflow, now, idempotencyKey: executionKey(workflow) });
    const budget = policy && decision?.allowed ? await budgetBlockReason(tx, workflow, policy) : null;
    const conflict = await conflictingWorkflowResource(tx, workflow);
    const owner = await workflowAccess(tx, { staffId: workflow.ownerId, agentRole: workflow.agentRole as WorkflowActor["agentRole"] }, workflow.marketId, workflow.action);
    return { workflowId: id, policy, eligibility, requiresReview: Boolean(decision?.allowed && decision.review),
      canQueue: Boolean(owner && decision?.allowed && eligibility.ok && !budget && !conflict),
      reason: !decision ? "The workflow role is unavailable." : !decision.allowed ? decision.reason
        : !owner ? "The workflow owner no longer has this market action permission."
          : !eligibility.ok ? eligibility.reason : budget ?? (conflict ? "This resource is already reserved by another workflow." : null) };
  }, options);
}

async function endJob(tx: Prisma.TransactionClient, workflow: JobWorkflow, status: "FAILED" | "EXPIRED", reason: string, now: Date) {
  if (workflow.job) await tx.operationalWorkflowJob.update({ where: { workflowId: workflow.id }, data: {
    status: status === "FAILED" ? "DEAD" : "CANCELLED", leaseToken: null, leaseUntil: null, retryable: false, lastError: reason,
  } });
  await tx.operationalWorkflow.update({ where: { id: workflow.id }, data: { status, blockReason: reason, committedMinor: 0, resourceHeld: false } });
  await appendWorkflowEvent(tx, workflow.id, status, { reason, attempts: workflow.job?.attempts ?? 0, releasedMinor: workflow.committedMinor }, undefined, now);
  return { kind: "processed", workflowId: workflow.id, status } as const;
}

async function retryOrFail(tx: Prisma.TransactionClient, workflow: JobWorkflow, reason: string, retryable: boolean, now: Date): Promise<WorkerResult> {
  const job = workflow.job;
  if (!retryable || !job || job.attempts >= job.maxAttempts) return endJob(tx, workflow, "FAILED", reason, now);
  const retryAt = new Date(+now + Math.min(300_000, 10_000 * 2 ** (job.attempts - 1)));
  if (retryAt >= workflow.evidenceExpiresAt) return endJob(tx, workflow, "EXPIRED", "The evidence expires before another bounded retry.", now);
  await tx.operationalWorkflowJob.update({ where: { workflowId: workflow.id }, data: {
    status: "QUEUED", availableAt: retryAt, leaseToken: null, leaseUntil: null, retryable: true, lastError: reason,
  } });
  await tx.operationalWorkflow.update({ where: { id: workflow.id }, data: { status: "READY", blockReason: reason } });
  await appendWorkflowEvent(tx, workflow.id, "RETRY_SCHEDULED", { reason, attempts: job.attempts, retryAt: retryAt.toISOString() }, undefined, now);
  return { kind: "processed", workflowId: workflow.id, status: "READY", retryAt };
}

async function claimWorkflow(filters: WorkerFilters, workerId: string, now: Date): Promise<Claimed | WorkerResult | null> {
  return getDb().$transaction(async tx => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT w.id FROM "OperationalWorkflow" AS w INNER JOIN "OperationalWorkflowJob" AS j ON w.id = j."workflowId"
      WHERE ((w.status = 'READY' AND j.status = 'QUEUED' AND j."availableAt" <= ${now})
        OR (w.status = 'RUNNING' AND j.status = 'LEASED' AND j."leaseUntil" <= ${now}))
        ${scoped(filters)}
      ORDER BY j."availableAt", w."createdAt", w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1
    `;
    if (!row) return null;
    const workflow = await tx.operationalWorkflow.findUnique({ where: { id: row.id }, include: { job: true } });
    if (!workflow?.job) return null;
    if (workflow.evidenceExpiresAt <= now) return endJob(tx, workflow, "EXPIRED", "The evidence window closed before execution.", now);
    if (workflow.job.attempts >= workflow.job.maxAttempts) return endJob(tx, workflow, "FAILED", "The worker lease expired at the retry limit.", now);
    const leaseToken = randomUUID();
    const recovered = workflow.job.status === "LEASED";
    await tx.operationalWorkflowJob.update({ where: { workflowId: row.id }, data: {
      status: "LEASED", attempts: { increment: 1 }, leaseToken, leaseUntil: new Date(+now + leaseMs), workerId,
    } });
    await tx.operationalWorkflow.update({ where: { id: row.id }, data: { status: "RUNNING", blockReason: null } });
    await appendWorkflowEvent(tx, row.id, recovered ? "LEASE_RECOVERED" : "RUN_STARTED", { attempt: workflow.job.attempts + 1, workerId }, undefined, now);
    return { kind: "claimed", workflowId: row.id, leaseToken };
  }, options);
}

async function validateExecution(tx: Prisma.TransactionClient, workflow: JobWorkflow, now: Date, policy: EffectiveWorkflowPolicy) {
  const owner = { staffId: workflow.ownerId, agentRole: workflow.agentRole as WorkflowActor["agentRole"] };
  if (!await workflowAccess(tx, owner, workflow.marketId, workflow.action, true)) return "The workflow owner no longer has this market action permission.";
  if (workflow.policyVersion !== policy.policyVersion) return "The execution policy changed after queueing. Review a new draft under the current policy.";
  const decision = workflowExecutionPolicy(workflow, policy, now);
  if (!decision.allowed) return decision.reason;
  if (decision.review && (!workflow.approvedBy || workflow.approvedPolicy !== policy.policyVersion ||
      !await workflowAccess(tx, { staffId: workflow.approvedBy }, workflow.marketId, workflow.action, true))) {
    return "The required staff decision is no longer authorized under the current policy.";
  }
  if (!workflow.resourceHeld || workflow.committedMinor !== (workflow.budgetMinor ?? 0)) return "The workflow no longer holds the expected resource and budget commitment.";
  return budgetBlockReason(tx, workflow, policy);
}

async function deferredByDailyLimit(tx: Prisma.TransactionClient, workflow: JobWorkflow, policy: EffectiveWorkflowPolicy, now: Date) {
  const { test, marketId, agentRole, action } = workflow;
  const { timeZone } = marketConfiguration(marketId);
  const dayLabel = marketDay(now, timeZone);
  const from = marketDayStart(dayLabel, timeZone);
  const next = shiftCalendarDay(dayLabel, 1);
  const until = next && marketDayStart(next, timeZone);
  if (!from || !until) throw new OperationError("The market's workflow calendar is unavailable.");
  await lockWorkflowKey(tx, `workflow-daily-cap:${test}:${marketId}:${agentRole ?? "STAFF"}:${action}:${dayLabel}`);
  const completed = await tx.operationalWorkflow.count({ where: { test, marketId, agentRole, action, status: "COMPLETED",
    completedAt: { gte: from, lt: until } } });
  if (completed < policy.maxRunsPerDay) return null;
  if (until >= workflow.evidenceExpiresAt) return endJob(tx, workflow, "EXPIRED", "Evidence expires before the market’s daily execution limit resets.", now);
  const reason = "The market’s daily execution limit was reached. This job will resume on the next market day.";
  // Policy deferral has no adapter effects and does not consume the new attempt.
  await tx.operationalWorkflowJob.update({ where: { workflowId: workflow.id }, data: { status: "QUEUED", availableAt: until,
    attempts: { decrement: 1 }, leaseToken: null, leaseUntil: null, retryable: false, lastError: reason } });
  await tx.operationalWorkflow.update({ where: { id: workflow.id }, data: { status: "READY", blockReason: reason } });
  await appendWorkflowEvent(tx, workflow.id, "DAILY_LIMIT_DEFERRED", { limit: policy.maxRunsPerDay, availableAt: until.toISOString() }, undefined, now);
  return { kind: "processed", workflowId: workflow.id, status: "READY", retryAt: until } as const;
}

async function finalizeExecution(tx: Prisma.TransactionClient, workflow: JobWorkflow, result: WorkflowResult, now: Date) {
  const spent = minorUnits.safeParse(result.spentMinor ?? 0);
  if (!spent.success || spent.data > workflow.committedMinor || !result.details || typeof result.details !== "object" || Array.isArray(result.details) ||
      JSON.stringify(result.details).length > 20_000 || result.reference !== undefined && !workflowText(600).safeParse(result.reference).success) {
    throw new OperationError("The adapter returned an invalid durable outcome.");
  }
  const keepResource = workflow.action === "PURCHASE_PROPOSAL";
  const keepCommitment = keepResource || workflow.action === "TEST_PLAN";
  const record = { details: result.details, spentMinor: spent.data, ...(result.reference && { reference: result.reference }) };
  await tx.operationalWorkflowJob.update({ where: { workflowId: workflow.id }, data: {
    status: "DONE", leaseToken: null, leaseUntil: null, retryable: false, lastError: null,
  } });
  await tx.operationalWorkflow.update({ where: { id: workflow.id }, data: {
    status: "COMPLETED", completedAt: now, blockReason: null, result: record,
    spentMinor: spent.data, committedMinor: keepCommitment ? workflow.committedMinor - spent.data : 0, resourceHeld: keepResource,
  } });
  await appendWorkflowEvent(tx, workflow.id, "COMPLETED", { idempotencyKey: executionKey(workflow), spentMinor: spent.data,
    heldMinor: keepCommitment ? workflow.committedMinor - spent.data : 0, resourceHeld: keepResource, ...(result.reference && { reference: result.reference }) }, undefined, now);
  return { kind: "processed", workflowId: workflow.id, status: "COMPLETED" } as const;
}

export async function runNextWorkflow(input: WorkerOptions): Promise<WorkerResult | null> {
  if (input.marketIds?.length === 0 || input.workflowId && !z.uuid().safeParse(input.workflowId).success) return null;
  const now = input.now ?? new Date();
  const workerId = workerIdentity.safeParse(input.workerId ?? "workflow-worker").data ?? "workflow-worker";
  const claim = await claimWorkflow(input, workerId, now);
  if (!claim || claim.kind !== "claimed") return claim;
  const { workflowId, leaseToken } = claim;
  try {
    return await getDb().$transaction(async tx => {
      const workflow = await lockWorkflow(tx, workflowId);
      // Fenced so a restarted worker cannot commit after another claim, even if its
      // process resumes late. The adapter and this terminal write commit together.
      const executionAt = input.now ?? new Date();
      if (!workflow || workflow.status !== "RUNNING" || workflow.job?.leaseToken !== leaseToken ||
          !workflow.job.leaseUntil || workflow.job.leaseUntil <= executionAt) return null;
      if (workflow.evidenceExpiresAt <= executionAt) return endJob(tx, workflow, "EXPIRED", "The evidence window closed before execution.", executionAt);
      await lockWorkflowResources(tx, workflow);
      const policy = policyForWorkflow(workflow);
      if (!policy) return endJob(tx, workflow, "FAILED", "The workflow role cannot execute this action.", executionAt);
      const blocked = await validateExecution(tx, workflow, executionAt, policy);
      if (blocked) return endJob(tx, workflow, "FAILED", blocked, executionAt);
      const deferred = await deferredByDailyLimit(tx, workflow, policy, executionAt);
      if (deferred) return deferred;
      const adapter = input.adapters[workflow.action];
      if (!adapter) return endJob(tx, workflow, "FAILED", "The action adapter is unavailable.", executionAt);
      const context = { tx, workflow, now: executionAt, idempotencyKey: executionKey(workflow) };
      const eligibility = await adapter.validate(context);
      if (!eligibility.ok) return retryOrFail(tx, workflow, safeReason(eligibility.reason, "This action is no longer eligible."), eligibility.retryable === true, executionAt);
      return finalizeExecution(tx, workflow, await adapter.execute(context), executionAt);
    }, options);
  } catch (error) {
    reportFailure("workflow.execute", undefined, error);
    // The execution transaction rolled back. Recover durable status in a new one.
    return getDb().$transaction(async tx => {
      const workflow = await lockWorkflow(tx, workflowId);
      if (!workflow || workflow.status !== "RUNNING" || workflow.job?.leaseToken !== leaseToken) return null;
      const reason = error instanceof OperationError ? safeReason(error.message, "The action could not execute.") : "The action could not finish safely. Check the job log before execution is attempted again.";
      return retryOrFail(tx, workflow, reason, !(error instanceof OperationError), input.now ?? new Date());
    }, options);
  }
}

export async function sweepWorkflowLifecycle(filters: WorkerFilters & { now?: Date } = {}) {
  if (filters.marketIds?.length === 0 || filters.workflowId && !z.uuid().safeParse(filters.workflowId).success) return 0;
  const now = filters.now ?? new Date();
  return getDb().$transaction(async tx => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT w.id FROM "OperationalWorkflow" AS w
      WHERE w."evidenceExpiresAt" <= ${now} AND (
        w.status IN ('DRAFT', 'READY', 'AWAITING_DECISION') OR
        (w.status = 'COMPLETED' AND (w."resourceHeld" OR w."committedMinor" > 0))
      ) ${scoped(filters)}
      ORDER BY w."evidenceExpiresAt", w.id FOR UPDATE SKIP LOCKED LIMIT 50
    `;
    for (const row of rows) {
      const workflow = await tx.operationalWorkflow.findUnique({ where: { id: row.id }, include: { job: true } });
      if (!workflow) continue;
      if (workflow.status !== "COMPLETED") await endJob(tx, workflow, "EXPIRED", "The evidence window has closed.", now);
      else {
        await tx.operationalWorkflow.update({ where: { id: row.id }, data: { committedMinor: 0, resourceHeld: false } });
        await appendWorkflowEvent(tx, row.id, "RESERVATION_EXPIRED", { releasedMinor: workflow.committedMinor }, undefined, now);
      }
    }
    return rows.length;
  }, options);
}

export async function runDueWorkflowReviews(input: WorkerFilters & { evaluator: WorkflowEvaluator; now?: Date; limit?: number }) {
  if (input.workflowId && !z.uuid().safeParse(input.workflowId).success) return [];
  const now = input.now ?? new Date();
  const rows = await getDb().operationalWorkflow.findMany({ where: {
    id: input.workflowId, marketId: input.marketIds ? { in: [...input.marketIds] } : undefined, test: input.test, status: "COMPLETED", outcomeReviewAt: { lte: now },
    reviews: { none: { OR: [{ outcome: { in: ["SUCCESSFUL", "UNSUCCESSFUL"] } }, { createdAt: { gt: new Date(+now - day) } }] } },
  }, orderBy: [{ outcomeReviewAt: "asc" }, { id: "asc" }], take: Math.max(1, Math.min(input.limit ?? 10, 25)) });
  const processed = [];
  for (const row of rows) {
    const result = await input.evaluator(row, now).catch(error => { reportFailure("workflow.review", undefined, error); return null; });
    if (result) processed.push(await recordWorkflowReview(null, row.id, result, now));
  }
  return processed;
}
