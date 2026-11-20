import { z } from "zod";
import { recommendationExperimentPlan } from "../catalog/recommendation-experiment-plan.ts";
import { productionDatabase } from "../db/local.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { OperationError } from "../staff/operations.ts";
import { workflowActionInputs } from "./action-input.ts";
import { workflowProductEligibility } from "./eligibility.ts";
import { intelligenceWorkflowEvidence } from "./evidence.ts";
import { prepareHomepageWorkflow, type PreparedWorkflow } from "./homepage.ts";
import { preparePurchaseWorkflow } from "./purchasing.ts";
import { workflowInput, type WorkflowAdapter, type WorkflowAdapters, type WorkflowContext } from "./types.ts";

export { workflowActionInputs };

async function scopedEvidence({ tx, workflow, now }: WorkflowContext) {
  const evidence = workflowInput.shape.evidence.safeParse(workflow.evidence);
  if (!evidence.success) throw new OperationError("A scoped evidence record is required for execution.");
  const sources: (NonNullable<Awaited<ReturnType<typeof intelligenceWorkflowEvidence>>>)[] = [];
  for (const { kind, ref, from, to } of evidence.data) {
    if (kind === "intelligence-draft") {
      const data = await intelligenceWorkflowEvidence({ db: tx, actorId: workflow.ownerId, draftId: ref });
      if (!data || data.marketId !== workflow.marketId || data.test !== workflow.test || from !== data.from || to !== data.to) {
        throw new OperationError("The cited Product Intelligence evidence is unavailable in this market and dataset.");
      }
      const { timeZone } = marketConfiguration(workflow.marketId);
      const expiryDay = shiftCalendarDay(data.to, 8);
      const expiry = expiryDay && marketDayStart(expiryDay, timeZone);
      if (workflow.action !== "HOME_ROLLBACK" && (!expiry || expiry <= now || data.to >= marketDay(now, timeZone))) {
        throw new OperationError("The cited evidence must cover closed market days and remain current. Save a fresh insight.");
      }
      sources.push(data);
      continue;
    }
    if (kind === "workflow" && z.uuid().safeParse(ref).success) {
      const exists = await tx.operationalWorkflow.count({ where: { id: ref, marketId: workflow.marketId, test: workflow.test, status: "COMPLETED" } });
      if (exists) continue;
    }
    if (kind === "experiment" && ref === recommendationExperimentPlan.id) continue;
    throw new OperationError("Choose a saved Product Intelligence draft or completed workflow as evidence.");
  }
  const needsIntelligence = !["HOME_PUBLISH", "HOME_ROLLBACK"].includes(workflow.action);
  if (needsIntelligence && !sources.length) throw new OperationError("This action requires a persisted Product Intelligence evidence snapshot.");
  if (!needsIntelligence && !evidence.data.some(item => item.kind === "intelligence-draft" || item.kind === "workflow")) {
    throw new OperationError("The referenced homepage workflow is missing from the evidence list.");
  }
  return { evidence: evidence.data, sources };
}

function protectedAdapter(prepare: (context: WorkflowContext) => Promise<PreparedWorkflow>): WorkflowAdapter {
  const byTransaction = new WeakMap<WorkflowContext["tx"], { id: string; action: PreparedWorkflow }>();
  return {
    async validate(context) {
      try {
        if (context.workflow.test === productionDatabase()) throw new OperationError("Workflow evidence and execution must use the same environment.");
        const status = marketConfiguration(context.workflow.marketId).status;
        if (status !== "active" && status !== "staging") throw new OperationError("The market is unavailable for workflow execution.");
        byTransaction.set(context.tx, { id: context.workflow.id, action: await prepare(context) });
        return { ok: true };
      } catch (error) {
        if (error instanceof OperationError) return { ok: false, reason: error.message };
        throw error;
      }
    },
    async execute(context) {
      const prepared = byTransaction.get(context.tx);
      byTransaction.delete(context.tx);
      if (prepared?.id !== context.workflow.id) throw new OperationError("Revalidate the workflow inside the execution transaction.");
      return prepared.action();
    },
  };
}

const homepage = protectedAdapter(async context => {
  await scopedEvidence(context);
  return prepareHomepageWorkflow(context);
});

export const workflowAdapters: WorkflowAdapters = {
  HOME_DRAFT: homepage,
  HOME_PUBLISH: homepage,
  HOME_ROLLBACK: homepage,
  PURCHASE_PROPOSAL: protectedAdapter(async context => {
    const { sources } = await scopedEvidence(context);
    const purchase = workflowActionInputs.PURCHASE_PROPOSAL.safeParse(context.workflow.payload);
    if (!purchase.success || !sources.some(source => source.draftId === purchase.data.draftId && source.kind === "PURCHASING")) {
      throw new OperationError("This purchasing proposal does not match its cited Product Intelligence estimate.");
    }
    return preparePurchaseWorkflow(context);
  }),
  TEST_PLAN: protectedAdapter(async context => {
    await scopedEvidence(context);
    const { tx, workflow, now } = context;
    const parsed = workflowActionInputs.TEST_PLAN.safeParse(workflow.payload);
    if (!parsed.success) throw new OperationError("Choose an eligible test audience, candidate lineup and stopping criterion.");
    const { marketId, test } = workflow;
    if (workflow.budgetMinor === null || workflow.budgetCurrency !== marketConfiguration(marketId).currency) {
      throw new OperationError("A market-currency test budget is required for this plan.");
    }
    if (workflow.targetKey !== `test:${marketId}:${[...parsed.data.productIds].sort()[0]}`) throw new OperationError("Choose the candidate's market test resource.");
    const products = await workflowProductEligibility(tx, { marketId, test, now, productIds: parsed.data.productIds,
      minimumStock: parsed.data.minimumStock, requireDelivery: true });
    return async () => ({ details: { ...parsed.data, kind: "market-test-plan", products, marketId, test, budgetMinor: workflow.budgetMinor,
      budgetCurrency: workflow.budgetCurrency, campaignLaunched: false, experimentLaunched: false,
      integration: "A campaign or randomized test is not connected to this candidate plan." } });
  }),
  CONVERSION_TASK: protectedAdapter(async context => {
    const { tx, workflow } = context;
    const { sources } = await scopedEvidence(context);
    const parsed = workflowActionInputs.CONVERSION_TASK.safeParse(workflow.payload);
    if (!parsed.success) throw new OperationError("Separate measured facts, proposed causes, and any corrective action.");
    const { area, appliedWorkflowId } = parsed.data;
    const source = sources.find(item => workflow.targetKey === `conversion:${workflow.marketId}:${area}:${item.productId ?? "market"}`);
    if (!source) throw new OperationError("This investigation does not match the cited market or product scope.");
    const applied = appliedWorkflowId ? await tx.operationalWorkflow.findFirst({ where: { id: appliedWorkflowId, marketId: workflow.marketId,
      test: workflow.test, action: "HOME_PUBLISH", status: "COMPLETED" }, select: { id: true, completedAt: true } }) : null;
    if (appliedWorkflowId && !applied?.completedAt) throw new OperationError("The claimed corrective publication is unavailable in this market.");
    return async () => ({ reference: source.href, details: { ...parsed.data, kind: "conversion-investigation", facts: source.facts,
      sourceDraftId: source.draftId, productId: source.productId ?? null, variantId: source.variantId ?? null,
      changeApplied: Boolean(applied), appliedAt: applied?.completedAt?.toISOString() ?? null } });
  }),
  LISTING_DRAFT: protectedAdapter(async context => {
    const { sources } = await scopedEvidence(context);
    const { tx, workflow, now } = context;
    const parsed = workflowActionInputs.LISTING_DRAFT.safeParse(workflow.payload);
    if (!parsed.success) throw new OperationError("Choose typed, plain-text changes for a market listing.");
    const { productId } = parsed.data;
    if (workflow.targetKey !== `listing:${workflow.marketId}:${productId}` || !sources.some(source => source.productId === productId)) {
      throw new OperationError("The proposed listing change must match its Product Intelligence evidence.");
    }
    const [product] = await workflowProductEligibility(tx, { marketId: workflow.marketId, productIds: [productId], test: workflow.test, now });
    return async () => ({ reference: `/staff/catalog/products/${encodeURIComponent(product.id)}`, details: { ...parsed.data,
      kind: "listing-draft", baseRevision: product.revision, productName: product.name, liveListingChanged: false } });
  }),
};
