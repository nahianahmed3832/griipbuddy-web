import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { bridgeOrderMeasurement, bridgeOrderSelect, projectBridgeOutcomes } from "../measurement/bridge-outcomes.ts";
import { cohortWindow, measurementRetentionDays } from "../measurement/domain.ts";
import { commerceOutcomeSelect, failedPaymentAttempts, orderMeasurement, projectCommerceOutcomes } from "../measurement/outcomes.ts";
import { experimentResults, type ExperimentObservation, type ExperimentOrder } from "./recommendation-experiment-analysis.ts";
import { recommendationExperimentPlan as plan } from "./recommendation-experiment-plan.ts";

const day = 86_400_000;
const maxBatch = 10_000;

export async function recommendationExperimentReport(input: { marketId: MarketId; test: boolean; from?: string; to?: string; now?: Date }) {
  const now = input.now ?? new Date();
  const market = marketConfiguration(input.marketId);
  const window = cohortWindow(now, input.from, input.to, market.timeZone);
  const bookingUntil = new Date(Math.min(+now, +window.until + plan.bookingDays * day));
  const cutoff = new Date(Math.min(+now, +window.until + plan.fulfillmentDays * day));
  return getDb().$transaction(async db => {
    const assignments = await db.recommendationExperimentAssignment.findMany({
      where: { marketId: market.id, experimentId: plan.id, assignedAt: { gte: window.fromAt, lt: window.until },
        journey: { test: input.test, grantedAt: { gte: new Date(+now - measurementRetentionDays * day) } } },
      select: { id: true, journeyId: true, variant: true, latencyMs: true, assignedAt: true, journey: { select: { expiresAt: true } } },
      take: maxBatch + 1,
    });
    if (assignments.length > maxBatch) return { kind: "window-too-large" as const, window };
    const base = { window, now, marketId: market.id, currency: market.currency, test: input.test,
      // The shared native provider failure bridge is scoped to the sandbox.
      providerFailureAvailable: input.test && market.payments.some(payment => payment.enabled && payment.evidence === "sandbox" && payment.method !== "COD"),
    };
    if (!assignments.length) return { ...base, kind: "ready" as const,
      results: experimentResults({ ...base, members: [], observations: [], orders: [] }) };
    const journeyIds = assignments.map(row => row.journeyId);
    const linkedJourney = { journeyId: { in: journeyIds } };
    const orderScope = { marketId: market.id, currency: market.currency, createdAt: { gte: window.fromAt, lt: bookingUntil } };
    const evidence = input.test ? { in: ["fixture", "sandbox"] as ("fixture" | "sandbox")[] } : "production" as const;
    const checkoutKinds = ["CHECKOUT_START", "CHECKOUT_FAILURE"] as const;
    const events = await db.measurementEvent.findMany({
      where: { ...linkedJourney, marketId: market.id, at: { gte: window.fromAt, lte: bookingUntil }, OR: [
        { kind: "EXPERIMENT_EXPOSURE", experimentAssignment: { in: assignments.map(row => row.id) } },
        { kind: { in: [...checkoutKinds] } },
      ] },
      select: { kind: true, journeyId: true, at: true, experimentAssignment: true, recommendationVersion: true, homepageConfig: true }, take: maxBatch + 1,
    });
    const native = await db.order.findMany({
      where: { ...orderScope, measurementTest: input.test, commerceEvidence: evidence,
        OR: [{ measurement: linkedJourney }, { attempt: { measurement: linkedJourney } }] },
      select: commerceOutcomeSelect, take: maxBatch + 1,
    });
    const bridged = await db.bridgeOrder.findMany({
      where: { ...orderScope, evidence, measurement: linkedJourney }, select: bridgeOrderSelect, take: maxBatch + 1,
    });
    const failed = await failedPaymentAttempts(db, { marketId: market.id, test: input.test, fromAt: window.fromAt,
      until: bookingUntil, take: maxBatch + 1, journeyIds });
    if (Math.max(events.length, native.length + bridged.length, failed.length) > maxBatch) return { kind: "window-too-large" as const, window };
    const members = assignments.map(({ journey, ...record }) => ({ ...record, expiresAt: journey.expiresAt }));
    const orders: ExperimentOrder[] = [
      ...native.flatMap(order => {
        const measurement = orderMeasurement(order);
        return measurement ? [{ ...order, journeyId: measurement.journeyId, outcomes: projectCommerceOutcomes(order, cutoff) }] : [];
      }),
      ...bridged.flatMap(order => {
        const measurement = bridgeOrderMeasurement(order);
        return measurement ? [{ ...order, journeyId: measurement.journeyId, outcomes: projectBridgeOutcomes(order, cutoff) }] : [];
      }),
    ];
    const observations = events.filter((event): event is ExperimentObservation =>
      event.kind === "EXPERIMENT_EXPOSURE" || checkoutKinds.some(kind => kind === event.kind));
    return { ...base, kind: "ready" as const, results: experimentResults({ ...base, members, observations, orders, paymentFailures: failed }) };
  }, { isolationLevel: "RepeatableRead", timeout: 12_000 });
}
