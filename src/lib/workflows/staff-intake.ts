import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { localMarketTime, marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { staffMarketIds } from "../staff/market-access.ts";
import { OperationError } from "../staff/operations.ts";
import { workflowActionInputs } from "./action-input.ts";
import { intelligenceWorkflowEvidence } from "./evidence.ts";
import { effectiveWorkflowPolicy } from "./policy.ts";
import { quoteWorkflowPurchase } from "./purchasing.ts";
import type { WorkflowActor, WorkflowInput } from "./types.ts";

export const intakeActions = ["HOME_DRAFT", "PURCHASE_PROPOSAL", "TEST_PLAN", "CONVERSION_TASK", "LISTING_DRAFT"] as const;
export type IntakeAction = typeof intakeActions[number];
const sourceId = z.string().regex(/^[a-f0-9]{64}$/);
const productId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const day = z.iso.date();
const plain = (min: number, max: number) => z.string().trim().min(min).max(max).refine(value => !/[<>\p{Cc}]/u.test(value));

export async function workflowInsight(staffId: string, value: unknown) {
  const parsed = sourceId.safeParse(value);
  if (!parsed.success) return null;
  const source = await intelligenceWorkflowEvidence({ actorId: staffId, draftId: parsed.data });
  return source ? { source, market: marketConfiguration(source.marketId) } : null;
}

export async function workflowIntakeActions(staffId: string, marketId: MarketId, subject: { productId?: string; kind: string }) {
  const [merch, ops] = await Promise.all([staffMarketIds(staffId, "merchandising"), staffMarketIds(staffId, "operations")]);
  return intakeActions.filter(action => action === "PURCHASE_PROPOSAL" ? ops.includes(marketId) && subject.kind === "PURCHASING" && subject.productId
    : action === "CONVERSION_TASK" ? true
      : merch.includes(marketId) && (action === "TEST_PLAN" || subject.productId));
}

const value = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const optional = (form: FormData, name: string) => value(form, name) || undefined;
const whole = (form: FormData, name: string, min: number, max: number) => {
  const text = optional(form, name);
  if (!text) return undefined;
  const parsed = z.int().min(min).max(max).safeParse(/^\d+$/.test(text) ? Number(text) : NaN);
  if (!parsed.success) throw new OperationError("Use the requested number range in the workflow form.");
  return parsed.data;
};
function requiredText(form: FormData, name: string, min: number, max: number) {
  const parsed = plain(min, max).safeParse(value(form, name));
  if (!parsed.success) throw new OperationError("Enter the required workflow details as plain text.");
  return parsed.data;
}

export function defaultOutcomeDay(marketId: MarketId, now = new Date()) {
  const timeZone = marketConfiguration(marketId).timeZone;
  return shiftCalendarDay(marketDay(now, timeZone), 7)!;
}

export async function compileWorkflowIntake(actor: WorkflowActor, form: FormData, now = new Date()): Promise<WorkflowInput> {
  const action = z.enum(intakeActions).safeParse(form.get("action"));
  const insight = await workflowInsight(actor.staffId, form.get("draft"));
  if (!action.success || !insight) throw new OperationError("Choose a workflow and a saved market insight.");
  const { source, market } = insight;
  const allowed = await workflowIntakeActions(actor.staffId, market.id, source);
  if (!allowed.includes(action.data)) throw new OperationError("This action is unavailable in your market permissions.");

  const reviewDate = day.safeParse(value(form, "reviewOn") || defaultOutcomeDay(market.id, now));
  const reviewAt = reviewDate.success ? marketDayStart(reviewDate.data, market.timeZone) : null;
  const expiryDay = shiftCalendarDay(source.to, 8);
  const expiresAt = expiryDay ? marketDayStart(expiryDay, market.timeZone) : null;
  if (!reviewAt || +reviewAt <= +now) throw new OperationError("Choose a review date after today in this market.");
  if (!expiresAt || +expiresAt <= +now) throw new OperationError("This evidence is stale. Save a recent insight before creating a workflow.");
  const primary = source.productId;
  const products = (optional(form, "productIds") ?? primary ?? "").split(/[,\s]+/).filter(Boolean);
  const productIds = [...new Set(products)];
  if (productIds.length > 12 || productIds.some(id => !productId.safeParse(id).success)) throw new OperationError("Use up to 12 valid catalog product IDs.");
  const locale = optional(form, "locale") ?? market.defaultLocale;
  const money = whole(form, "budgetMinor", 1, 999_999_999);
  const executionPolicy = effectiveWorkflowPolicy({ marketId: market.id, test: source.test, role: actor.agentRole ?? "STAFF", action: action.data });
  if (money && action.data !== "TEST_PLAN") throw new OperationError("Only a test plan accepts a manually proposed budget.");
  let budget = money ? { minor: money, currency: market.currency, ledgerKey: executionPolicy.budget?.ledgerKey ?? "unassigned" } : undefined;
  let stock: number | undefined;
  let payload: WorkflowInput["payload"];
  let targetKey: string;

  switch (action.data) {
    case "HOME_DRAFT": {
      if (!market.languages.includes(locale) || !productIds.length) throw new OperationError("Choose an eligible locale and a product lineup.");
      const startsLocal = optional(form, "startsLocal"), endsLocal = optional(form, "endsLocal");
      if ([startsLocal, endsLocal].some(time => time && !localMarketTime(time, market.timeZone))) throw new OperationError("Use valid market-local schedule times.");
      const rankingPlacement = z.literal("recommended").optional().safeParse(optional(form, "rankingPlacement"));
      if (!rankingPlacement.success) throw new OperationError("Choose a supported homepage placement.");
      payload = { locale, productIds, sectionTitle: requiredText(form, "sectionTitle", 2, 90),
        ...(startsLocal && { startsLocal }), ...(endsLocal && { endsLocal }), ...(rankingPlacement.data && { rankingPlacement: rankingPlacement.data }) };
      targetKey = `homepage:${market.id}:${locale}`;
      break;
    }
    case "PURCHASE_PROPOSAL": {
      const quote = await quoteWorkflowPurchase(actor.staffId, source.draftId, now);
      payload = { draftId: source.draftId };
      targetKey = quote.targetKey;
      stock = quote.recommendation.available ?? undefined;
      budget = { minor: quote.estimatedCostMinor, currency: quote.currency, ledgerKey: quote.budgetLedgerKey };
      break;
    }
    case "TEST_PLAN": {
      if (!productIds.length) throw new OperationError("Choose candidate product IDs for this test.");
      const metric = z.enum(["verified-paid-orders", "product-to-cart"]).safeParse(value(form, "successMetric"));
      const durationDays = whole(form, "durationDays", 1, 56), minimumStock = whole(form, "minimumStock", 1, 100_000);
      const successThreshold = whole(form, "successThreshold", 1, 100_000);
      if (!metric.success || !durationDays || !minimumStock || !successThreshold) throw new OperationError("Define a duration, stock threshold and success criterion.");
      payload = { productIds, audience: "eligible-market-visitors", durationDays, minimumStock, successMetric: metric.data, successThreshold,
        stoppingRule: requiredText(form, "stoppingRule", 8, 300) };
      targetKey = `test:${market.id}:${[...productIds].sort()[0]}`;
      break;
    }
    case "CONVERSION_TASK": {
      const area = z.enum(["funnel", "payment", "search"]).safeParse(form.get("area"));
      if (!area.success) throw new OperationError("Choose a conversion evidence area.");
      const correctiveChange = optional(form, "correctiveChange");
      const metric = z.enum(["product-to-cart", "payment-failures", "zero-result-searches"]).optional().safeParse(optional(form, "successMetric"));
      const threshold = whole(form, "successThreshold", 0, 1_000_000);
      if (!metric.success || (metric.data === undefined) !== (threshold === undefined)) throw new OperationError("Provide both the outcome metric and threshold.");
      payload = { area: area.data, facts: source.facts, hypotheses: [source.hypothesis],
        ...(correctiveChange && { correctiveChange: requiredText(form, "correctiveChange", 4, 400) }),
        ...(metric.data && { successMetric: metric.data, successThreshold: threshold }) };
      targetKey = `conversion:${market.id}:${area.data}:${primary ?? "market"}`;
      break;
    }
    case "LISTING_DRAFT": {
      if (!primary) throw new OperationError("Choose a listing with verified product evidence.");
      const name = optional(form, "listingName"), shortDescription = optional(form, "shortDescription");
      if (!name && !shortDescription) throw new OperationError("Enter the proposed product title or short description.");
      payload = { productId: primary, changes: { ...(name && { name: requiredText(form, "listingName", 2, 120) }),
        ...(shortDescription && { shortDescription: requiredText(form, "shortDescription", 3, 300) }) } };
      targetKey = `listing:${market.id}:${primary}`;
      break;
    }
  }
  const title = requiredText(form, "title", 3, 160);
  const expectedOutcome = requiredText(form, "expectedOutcome", 8, 500);
  const uncertainty = requiredText(form, "uncertainty", 5, 400);
  const verifiedPayload = workflowActionInputs[action.data].safeParse(payload);
  if (!verifiedPayload.success) throw new OperationError(verifiedPayload.error.issues[0]?.message ?? "Review the proposed action fields.");
  return { action: action.data, marketId: market.id, test: source.test, targetKey, title, expectedOutcome, uncertainty, payload: verifiedPayload.data,
    evidence: [source.evidenceRef],
    outcomeReviewAt: reviewAt, evidenceExpiresAt: expiresAt, budget, stock,
    requestKey: stableMeasurementId("workflow-intake", market.id, String(source.test), source.draftId, action.data,
      JSON.stringify({ payload: verifiedPayload.data, title, expectedOutcome, uncertainty, reviewDate: reviewAt, budget })),
    benefit: whole(form, "benefit", 0, 100), confidence: whole(form, "confidence", 0, 100), effort: whole(form, "effort", 1, 100) };
}
