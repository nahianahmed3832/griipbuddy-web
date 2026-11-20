import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { lockDispatchLocations, lockVariantInventory } from "../commerce/location-inventory.ts";
import { marketHasDelivery } from "../commerce/orders.ts";
import type { DbReader } from "../db/client.ts";
import { forecastDemand } from "../intelligence/forecast.ts";
import { reviewPurchasingPolicy } from "../intelligence/forecast-board.ts";
import { loadDemandHistory } from "../intelligence/history.ts";
import { recommendInventory } from "../intelligence/inventory.ts";
import { maxIntelligenceDays } from "../intelligence/window.ts";
import { marketDay, shiftCalendarDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { OperationError } from "../staff/operations.ts";
import { workflowActionInputs } from "./action-input.ts";
import { intelligenceWorkflowEvidence } from "./evidence.ts";
import type { PreparedWorkflow } from "./homepage.ts";
import type { WorkflowContext } from "./types.ts";

const canonicalKey = z.string().max(240).regex(/^[A-Za-z0-9][A-Za-z0-9_:-]*$/);

export async function quoteWorkflowPurchase(actorId: string, draftId: string, now = new Date(), db?: DbReader) {
  const evidence = await intelligenceWorkflowEvidence({ db, actorId, draftId });
  if (evidence?.kind !== "PURCHASING" || !evidence.productId || !evidence.variantId) {
    throw new OperationError("Use an authorized variant-level purchasing draft from Product Intelligence.");
  }
  const { marketId, test, productId, variantId } = evidence;
  const market = marketConfiguration(marketId);
  const today = marketDay(now, market.timeZone);
  const history = await loadDemandHistory({ marketId, test, productId, variantId,
    from: shiftCalendarDay(today, -maxIntelligenceDays)!, to: shiftCalendarDay(today, -1)!, now }, db);
  if (history.kind !== "history") throw new OperationError("A current calibrated demand history is unavailable for this variant.");
  const policy = reviewPurchasingPolicy(history, variantId, today);
  if (!policy) throw new OperationError("A verified single-pool purchasing policy is unavailable for this variant and market.");
  const forecast = forecastDemand(history.observations, { identity: { marketId, productId, variantId }, asOfDay: today,
    horizonDays: policy.leadTimeDays + policy.reviewDays, coverage: policy.serviceTarget });
  const recommendation = recommendInventory({ position: { ...history.inventory, variantId }, marketId, marketCurrency: market.currency,
    deliveryAvailable: await marketHasDelivery(marketId, db), snapshotDay: today, forecasts: [forecast], policy });
  const { quantity, estimatedCostMinor, currency, poolId } = recommendation;
  if (recommendation.action !== "replenish" || !quantity || estimatedCostMinor === null || !currency || !poolId || !forecast.interval) {
    throw new OperationError(`The current quote cannot support a replenishment proposal. ${recommendation.reasons[0] ?? "Review the latest stock and supplier terms."}`);
  }
  if (evidence.quantity !== undefined && evidence.quantity !== quantity) throw new OperationError("Available stock, incoming goods or demand changed. Save a new Product Intelligence draft first.");
  const targetKey = canonicalKey.parse(`inventory:${poolId}`);
  const budgetLedgerKey = `purchasing:${marketId}`;
  return { evidence, recommendation, forecast, policy, quantity, estimatedCostMinor, currency, poolId, targetKey, budgetLedgerKey };
}

export async function preparePurchaseWorkflow({ tx, workflow, now }: WorkflowContext): Promise<PreparedWorkflow> {
  const parsed = workflowActionInputs.PURCHASE_PROPOSAL.safeParse(workflow.payload);
  if (!parsed.success) throw new OperationError("The purchasing draft reference is invalid.");
  const { draftId } = parsed.data;
  const initial = await intelligenceWorkflowEvidence({ db: tx, draftId, actorId: workflow.ownerId });
  if (!initial?.variantId || initial.marketId !== workflow.marketId || initial.test !== workflow.test) {
    throw new OperationError("The purchasing evidence is outside this workflow's market or evidence scope.");
  }
  await lockVariantInventory(tx, [initial.variantId]);
  await lockDispatchLocations(tx, [initial.variantId]);
  const quote = await quoteWorkflowPurchase(workflow.ownerId, draftId, now, tx);
  if (quote.targetKey !== workflow.targetKey || quote.estimatedCostMinor !== workflow.budgetMinor ||
      quote.currency !== workflow.budgetCurrency || quote.budgetLedgerKey !== workflow.budgetLedgerKey) {
    throw new OperationError("The current cost, currency or physical pool differs from the proposed commitment. Review a fresh quote.");
  }
  const { policy, recommendation, forecast } = quote;
  if (policy.availableBudgetMinor !== null) {
    const usage = await tx.operationalWorkflow.aggregate({ where: { id: { not: workflow.id }, test: workflow.test,
      budgetLedgerKey: quote.budgetLedgerKey, budgetCurrency: quote.currency }, _sum: { committedMinor: true, spentMinor: true } });
    if ((usage._sum.committedMinor ?? 0) + (usage._sum.spentMinor ?? 0) + quote.estimatedCostMinor > policy.availableBudgetMinor) {
      throw new OperationError("Recorded purchasing commitments exceed the remaining authorized purchasing budget.");
    }
  }
  return async () => ({ reference: `/staff/intelligence?market=${workflow.marketId}&scope=${workflow.test ? "test" : "live"}&view=drafts`,
    details: {
      kind: "purchasing-proposal", sourceDraftId: draftId, purchased: false, externallySubmitted: false,
      quantity: quote.quantity, costMinor: quote.estimatedCostMinor, currency: quote.currency, poolId: quote.poolId,
      forecast: { horizonDays: forecast.horizonDays, pointUnits: forecast.pointUnits, lowerUnits: forecast.interval!.lowerUnits,
        upperUnits: forecast.interval!.upperUnits, coverage: forecast.interval!.nominalCoverage },
      inventory: { available: recommendation.available, reserved: recommendation.reserved, incoming: recommendation.incomingDuringHorizon },
      terms: { source: policy.source, asOfDay: policy.asOfDay, unitCostMinor: policy.unitCostMinor, leadTimeDays: policy.leadTimeDays,
        reviewDays: policy.reviewDays, minimumOrderUnits: policy.minimumOrderUnits, unitsPerCase: policy.unitsPerCase,
        supplierOnTimeRate: policy.supplierOnTimeRate, safetyStockUnits: policy.safetyStockUnits },
    } satisfies Prisma.InputJsonObject,
  });
}
