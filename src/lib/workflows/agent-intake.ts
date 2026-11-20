import { getDb } from "../db/client.ts";
import { marketDay, shiftCalendarDay } from "../market-calendar.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { canProposeWorkflow, type WorkflowAgentAction, type WorkflowAgentBinding, type WorkflowAgentRequest } from "./agent-access.ts";
import { workflowActionInputs } from "./action-input.ts";
import { workflowProductEligibility } from "./eligibility.ts";
import { compileWorkflowIntake, workflowInsight } from "./staff-intake.ts";
import type { ParsedWorkflowInput, WorkflowActor, WorkflowInput } from "./types.ts";

const proposalDescriptions = {
  HOME_DRAFT: ["Homepage collection proposal", "Measure qualified exposure and shopping behavior for the reviewed homepage placement."],
  PURCHASE_PROPOSAL: ["Replenishment proposal", "Review whether a replenishment proposal can cover the forecast range within the allowed budget."],
  TEST_PLAN: ["Market product test proposal", "Record a decision against the declared conversion or paid purchase threshold after the review window."],
  CONVERSION_TASK: ["Conversion investigation proposal", "Connect the observed issue to a reproducible investigation and a measured follow-up."],
  LISTING_DRAFT: ["Listing improvement proposal", "Review the copy against verified product facts before any separate catalog action."],
} as const satisfies Record<WorkflowAgentAction, readonly [string, string]>;

export async function compileAgentProposal(agent: WorkflowAgentBinding, request: WorkflowAgentRequest, now = new Date()): Promise<{
  actor: WorkflowActor; input: WorkflowInput;
} | null> {
  if (!canProposeWorkflow(agent, request)) return null;
  const insight = await workflowInsight(agent.staffId, request.draftId);
  if (!insight || insight.source.marketId !== request.marketId || insight.source.test !== (request.scope === "test")) return null;
  const { market } = insight;
  const actor = { staffId: agent.staffId, agentRole: agent.role, agentId: agent.id } satisfies WorkflowActor;
  const form = new FormData();
  const [title, expected] = proposalDescriptions[request.action];
  form.set("draft", request.draftId);
  form.set("action", request.action);
  form.set("title", title);
  form.set("expectedOutcome", expected);
  form.set("uncertainty", "The saved evidence is observational. Recheck current eligibility and inputs before using the proposal.");
  if (request.action === "HOME_DRAFT") {
    form.set("sectionTitle", "Market collection under review");
    if (request.ranking) form.set("rankingPlacement", request.ranking);
  }
  if (request.action === "CONVERSION_TASK") form.set("area", request.area ?? "funnel");
  if (request.action === "LISTING_DRAFT") {
    if (request.listingName) form.set("listingName", request.listingName);
    if (request.shortDescription) form.set("shortDescription", request.shortDescription);
  }
  if (request.action === "TEST_PLAN") {
    const duration = request.durationDays ?? 7;
    const metric = request.successMetric ?? "verified-paid-orders";
    form.set("durationDays", String(duration));
    form.set("minimumStock", String(request.minimumStock ?? 1));
    form.set("successMetric", metric);
    form.set("successThreshold", String(request.successThreshold ?? 1));
    form.set("stoppingRule", "Stop if eligible stock is unavailable or the configured spend authority is reached.");
    form.set("reviewOn", shiftCalendarDay(marketDay(now, market.timeZone), duration + (metric === "verified-paid-orders" ? 14 : 1))!);
  }

  const input = await compileWorkflowIntake(actor, form, now);
  // Bind a replay to this delegated principal rather than a staff form or
  // another machine actor. Resource conflict checks remain in the engine.
  return { actor, input: { ...input, requestKey: stableMeasurementId("workflow-agent", agent.id, input.requestKey) } };
}

export async function checkAgentProposalEligibility(input: ParsedWorkflowInput, now = new Date()) {
  const { action, marketId, test, payload } = input;
  if (action !== "HOME_DRAFT" && action !== "TEST_PLAN" && action !== "LISTING_DRAFT") return;
  const listing = action === "LISTING_DRAFT";
  const productIds = listing ? [workflowActionInputs.LISTING_DRAFT.parse(payload).productId] : workflowActionInputs[action].parse(payload).productIds;
  const minimumStock = action === "TEST_PLAN" ? workflowActionInputs.TEST_PLAN.parse(payload).minimumStock : listing ? undefined : 1;
  await getDb().$transaction(tx => workflowProductEligibility(tx, { marketId, test, productIds, now,
    minimumStock, requireDelivery: !listing }));
}
