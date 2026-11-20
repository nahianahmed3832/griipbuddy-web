import { z } from "zod";
import type { OperationalWorkflow, Prisma } from "../../generated/prisma/client.ts";
import { recommendationExperimentPlan } from "../catalog/recommendation-experiment-plan.ts";
import { recommendationExperimentReport } from "../catalog/recommendation-experiment-report.ts";
import { scopeKey } from "../catalog/homepage-contract.ts";
import { getDb } from "../db/client.ts";
import { productIntelligence } from "../intelligence/dataset.ts";
import { loadDemandHistory } from "../intelligence/history.ts";
import { intelligenceUrl } from "../intelligence/navigation.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { workflowActionInputs, workflowProductId } from "./action-input.ts";
import { homepagePublicationResult } from "./homepage.ts";
import type { WorkflowEvaluator, WorkflowReviewResult } from "./types.ts";

const completedDetails = z.object({ details: z.record(z.string(), z.json()) }).transform(row => row.details);
const convertDetails = z.object({ appliedAt: z.iso.datetime().nullable(), changeApplied: z.boolean(),
  productId: workflowProductId.nullable(), variantId: workflowProductId.nullable() });
const purchaseDetails = z.object({ variantId: z.string().min(1).optional(), sourceDraftId: z.string().regex(/^[a-f0-9]{64}$/),
  quantity: z.int(), poolId: z.string() });

function review(workflow: OperationalWorkflow, now: Date, outcome: WorkflowReviewResult["outcome"], reason: string,
  evidence: Prisma.InputJsonObject = {}): WorkflowReviewResult {
  const { marketId, test, outcomeReviewAt } = workflow;
  return { reviewKey: `outcome-v1:${marketDay(now, marketConfiguration(marketId).timeZone)}`, outcome,
    evidence: { ...evidence, reason, marketId, scope: test ? "test" : "production", reviewedAt: now.toISOString(),
      scheduledReviewAt: outcomeReviewAt.toISOString(), causal: false } };
}

function operationsHref(workflow: OperationalWorkflow) {
  return `/staff/acquisition?market=${workflow.marketId}&scope=${workflow.test ? "test" : "live"}`;
}

async function reviewHomepage(workflow: OperationalWorkflow, now: Date, details: unknown) {
  const result = homepagePublicationResult.safeParse(details);
  if (!result.success) return review(workflow, now, "INCONCLUSIVE", "No verifiable publication or outcome criteria are associated with this workflow.");
  const { minimumImpressions, homepageConfig, productIds, placement, publishedAt, startsAt, endsAt } = result.data;
  const from = new Date(Math.max(+new Date(publishedAt), startsAt ? +new Date(startsAt) : 0));
  if (now <= from) return null;
  // Close exposure at the review time or scheduled end. A delayed review is not
  // allowed to include exposures from after the predeclared observation interval.
  const until = new Date(Math.min(+workflow.outcomeReviewAt, endsAt ? +new Date(endsAt) : Infinity));
  if (from >= until) return review(workflow, now, "INCONCLUSIVE", "The release or scheduled placement started after its planned observation window.");
  const observations = await getDb().measurementEvent.count({ where: { marketId: workflow.marketId, homepageConfig, placement,
    kind: "PRODUCT_IMPRESSION", productId: { in: productIds }, at: { gte: from, lt: until }, journey: { test: workflow.test, automated: false } } });
  const outcome = observations >= minimumImpressions ? "SUCCESSFUL" : observations ? "UNSUCCESSFUL" : "INCONCLUSIVE";
  const experimentHref = `${operationsHref(workflow).replace("/staff/acquisition?", "/staff/acquisition/experiments?")}`;
  const experiment: Record<string, Prisma.InputJsonValue | null> = { plan: recommendationExperimentPlan.id, source: experimentHref, interpretation: "not-applicable" };
  if (placement === "recommended") {
    const timeZone = marketConfiguration(workflow.marketId).timeZone;
    const tail = Math.min(+until - 1, +from + 6 * 86_400_000);
    const assignedThrough = new Date(tail);
    if (+now < tail + recommendationExperimentPlan.fulfillmentDays * 86_400_000) {
      experiment.interpretation = "delivery-collection-return-follow-up-pending";
      experiment.pendingUntil = new Date(tail + recommendationExperimentPlan.fulfillmentDays * 86_400_000).toISOString();
    } else {
      const source = await recommendationExperimentReport({ marketId: workflow.marketId, test: workflow.test, now,
        from: marketDay(from, timeZone), to: marketDay(assignedThrough, timeZone) }).catch(() => null);
      if (source?.kind === "ready" && source.results.homepageConfigs.length === 1 && source.results.homepageConfigs[0] === homepageConfig) {
        experiment.interpretation = source.results.interpretation;
        experiment.controlMature = source.results.control.mature;
        experiment.personalizedMature = source.results.personalized.mature;
        experiment.primaryLiftRange = source.results.liftInterval ? [...source.results.liftInterval] : null;
      } else experiment.interpretation = "no-matching-frozen-cohort";
    }
  }
  return review(workflow, now, outcome, observations ? "Compared observed reach with the predeclared placement target. Reach does not establish a sales lift."
    : "No opted-in impressions were observed for this exact placement and homepage release. Coverage is insufficient for a verdict.", {
    metric: "visible-product-impressions", observed: observations, target: minimumImpressions,
    from: from.toISOString(), until: until.toISOString(), exactHomepageConfig: homepageConfig,
    source: `${operationsHref(workflow)}&view=events`, experiment,
  });
}

async function reviewConversion(workflow: OperationalWorkflow, now: Date, details: unknown) {
  const input = workflowActionInputs.CONVERSION_TASK.safeParse(workflow.payload);
  const state = convertDetails.safeParse(details);
  if (!input.success || !state.success || !state.data.changeApplied || !state.data.appliedAt ||
      !input.data.successMetric || input.data.successThreshold === undefined) {
    return review(workflow, now, "INCONCLUSIVE", "The investigation was recorded. A verified applied change and predeclared success metric are still needed.", { source: operationsHref(workflow) });
  }
  const { marketId, test } = workflow;
  const { timeZone } = marketConfiguration(marketId);
  const from = shiftCalendarDay(marketDay(new Date(state.data.appliedAt), timeZone), 1)!;
  const to = shiftCalendarDay(marketDay(workflow.outcomeReviewAt, timeZone), -1)!;
  if (from > to || !marketDayStart(to, timeZone)) return review(workflow, now, "INCONCLUSIVE", "No complete market day lies between the applied change and the review.");
  const { productId, variantId } = state.data;
  const { successMetric: metric, successThreshold: target } = input.data;
  const report = await productIntelligence({ marketId, test, from, to, now,
    ...(metric === "product-to-cart" && productId && { productId, variantId: variantId ?? undefined }) });
  const href = intelligenceUrl({ market: marketId, scope: test ? "test" : "live", from, to,
    ...(metric === "product-to-cart" && productId && { product: productId, variant: variantId ?? undefined }),
    section: metric === "zero-result-searches" ? "search" : "conversion" });
  if (report.kind !== "report" || report.window.from !== from || report.window.to !== to) {
    return review(workflow, now, "INCONCLUSIVE", "The exact follow-up window is unavailable.", { source: href, from, to, target, metric });
  }
  const observed = metric === "zero-result-searches" ? report.searches.searches ? report.searches.zeroResults : null
    : metric === "payment-failures" ? report.market.paymentFailures : report.market.viewers ? report.market.viewedThenCart : null;
  const reached = observed !== null && (metric === "product-to-cart" ? observed >= target : observed <= target);
  return review(workflow, now, observed === null ? "INCONCLUSIVE" : reached ? "SUCCESSFUL" : "UNSUCCESSFUL",
    observed === null ? "The selected measure lacks verified coverage in the follow-up window."
      : "The observed count was compared with the predeclared target. Other changes can affect this comparison.",
    { source: href, from, to, metric, target, observed });
}

export const evaluateWorkflowOutcome: WorkflowEvaluator = async (workflow, now) => {
  if (workflow.status !== "COMPLETED" || !workflow.completedAt || now < workflow.outcomeReviewAt) return null;
  const details = completedDetails.safeParse(workflow.result);
  if (!details.success) return review(workflow, now, "INCONCLUSIVE", "No verified execution result is available.");
  switch (workflow.action) {
    case "HOME_PUBLISH": return reviewHomepage(workflow, now, details.data);
    case "CONVERSION_TASK": return reviewConversion(workflow, now, details.data);
    case "HOME_ROLLBACK": {
      const parsed = z.object({ locale: z.string(), releaseId: z.uuid().nullable(), revision: z.int() }).safeParse(details.data);
      const current = parsed.success ? await getDb().homepageContent.findUnique({ where: { key: scopeKey({ marketId: workflow.marketId, locale: parsed.data.locale }) },
        select: { publishedId: true, revision: true } }) : null;
      const same = parsed.success && current?.publishedId === parsed.data.releaseId;
      return review(workflow, now, same ? "SUCCESSFUL" : "INCONCLUSIVE", same ? "The restored homepage remains the current publication."
        : "The rollback publication was superseded or cannot be verified.", { source: "/staff/homepage" });
    }
    case "PURCHASE_PROPOSAL": {
      const parsed = purchaseDetails.safeParse(details.data);
      const source = parsed.success ? await getDb().intelligenceDraft.findFirst({ where: { id: parsed.data.sourceDraftId, marketId: workflow.marketId, test: workflow.test }, select: { evidence: true } }) : null;
      const identity = z.object({ productId: workflowProductId, variantId: workflowProductId }).safeParse(source?.evidence);
      const history = identity.success ? await loadDemandHistory({ ...identity.data, marketId: workflow.marketId, test: workflow.test, now }).catch(() => null) : null;
      return review(workflow, now, "INCONCLUSIVE", "The internal proposal does not establish external submission, receipt, or stock impact.", {
        source: intelligenceUrl({ market: workflow.marketId, scope: workflow.test ? "test" : "live", view: "forecast", ...(identity.success && {
          product: identity.data.productId, variant: identity.data.variantId }) }),
        availableNow: history?.kind === "history" ? history.inventory.available : null,
      });
    }
    case "TEST_PLAN": return review(workflow, now, "INCONCLUSIVE", "A test plan was saved. No launched campaign, assignment cohort, or settled outcome is connected.", { source: operationsHref(workflow) });
    case "LISTING_DRAFT": return review(workflow, now, "INCONCLUSIVE", "The listing suggestion was saved for review. No applied listing revision is connected.");
    case "HOME_DRAFT": return review(workflow, now, "INCONCLUSIVE", "The draft was saved. Evaluate shopper exposure on its separately executed publication.", { source: "/staff/homepage" });
  }
};
