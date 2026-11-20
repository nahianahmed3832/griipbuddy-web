import type { Currency, MarketId } from "../../config/markets.ts";
import { contributionProfit, type ContributionRecord } from "../measurement/contribution.ts";
import { wilsonInterval as wilson } from "../measurement/intervals.ts";
import type { CommerceOutcome } from "../measurement/outcomes.ts";
import { recommendationExperimentPlan as plan, type RecommendationExperimentArm } from "./recommendation-experiment-plan.ts";

const day = 86_400_000;

export type ExperimentMember = {
  id: string;
  journeyId: string;
  variant: RecommendationExperimentArm;
  assignedAt: Date;
  expiresAt: Date;
  latencyMs: number | null;
};

export type ExperimentObservation = {
  journeyId: string;
  experimentAssignment: string | null;
  recommendationVersion: string | null;
  homepageConfig: string | null;
  kind: "EXPERIMENT_EXPOSURE" | "CHECKOUT_START" | "CHECKOUT_FAILURE";
  at: Date;
};

export type ExperimentOrder = {
  id: string;
  journeyId: string;
  marketId: MarketId;
  currency: Currency;
  createdAt: Date;
  updatedAt?: Date;
  contributionEvidence?: ContributionRecord | null;
  outcomes: CommerceOutcome[];
};

type Evidence = "fixture" | "sandbox" | "production";
export type ExperimentPaymentFailure = Pick<CommerceOutcome, "journeyId" | "marketId" | "at" | "evidence">;
const evidenceAllowed = (value: CommerceOutcome["evidence"], test: boolean): value is Evidence =>
  test ? value === "fixture" || value === "sandbox" : value === "production";

export function experimentResults(input: {
  members: readonly ExperimentMember[];
  observations: readonly ExperimentObservation[];
  orders: readonly ExperimentOrder[];
  paymentFailures?: readonly ExperimentPaymentFailure[];
  providerFailureAvailable?: boolean;
  marketId: MarketId;
  currency: Currency;
  test: boolean;
  now: Date;
}) {
  const membersByJourney = new Map(input.members.map(member => [member.journeyId, member]));
  const exposure = new Map<string, { version: string; homepageConfig: string | null }>();
  const checkout = new Set<string>();
  const checkoutFailed = new Set<string>();
  const paymentFailed = new Set<string>();
  const byJourney = new Map<string, ExperimentOrder[]>();
  const evidence = new Set<Evidence>();
  const bookingCutoff = (member: ExperimentMember) => Math.min(+member.assignedAt + plan.bookingDays * day, +member.expiresAt);
  const withinBooking = (member: ExperimentMember, at: Date) => +at >= +member.assignedAt && +at < bookingCutoff(member) && +at <= +input.now;
  for (const item of input.observations) {
    const member = membersByJourney.get(item.journeyId);
    if (!member || !withinBooking(member, item.at)) continue;
    if (item.kind === "EXPERIMENT_EXPOSURE") {
      if (item.experimentAssignment !== member.id || !item.recommendationVersion) continue;
      if (!exposure.has(member.id)) exposure.set(member.id, { version: item.recommendationVersion, homepageConfig: item.homepageConfig });
    } else {
      checkout.add(member.id);
      if (item.kind === "CHECKOUT_FAILURE") checkoutFailed.add(member.id);
    }
  }
  for (const order of input.orders) {
    const member = membersByJourney.get(order.journeyId);
    if (!member || order.marketId !== input.marketId || order.currency !== input.currency || !withinBooking(member, order.createdAt)) continue;
    const outcomes = order.outcomes.filter(event => event.marketId === input.marketId && event.currency === input.currency && evidenceAllowed(event.evidence, input.test) &&
      +event.at >= +order.createdAt && +event.at <= Math.min(+input.now, +member.assignedAt + plan.fulfillmentDays * day));
    if (!outcomes.some(event => event.kind === "ORDER_ACCEPTED")) continue;
    for (const event of outcomes) if (evidenceAllowed(event.evidence, input.test)) evidence.add(event.evidence);
    const orders = byJourney.get(order.journeyId) ?? [];
    orders.push({ ...order, outcomes });
    byJourney.set(order.journeyId, orders);
  }
  for (const failure of input.paymentFailures ?? []) {
    const member = failure.journeyId && membersByJourney.get(failure.journeyId);
    if (member && failure.marketId === input.marketId && withinBooking(member, failure.at) && evidenceAllowed(failure.evidence, input.test)) {
      paymentFailed.add(member.id);
      evidence.add(failure.evidence);
    }
  }
  const result = (variant: RecommendationExperimentArm) => {
    const assigned = input.members.filter(member => member.variant === variant);
    const mature = assigned.filter(member => +member.assignedAt + plan.collectionDays * day <= +input.now);
    const fulfillmentMature = assigned.filter(member => +member.assignedAt + plan.fulfillmentDays * day <= +input.now);
    const versions = [...new Set(assigned.flatMap(member => {
      const observed = exposure.get(member.id);
      return observed ? [observed.version] : [];
    }))].sort();
    const latency = assigned.flatMap(member => member.latencyMs === null ? [] : [member.latencyMs]).sort((a, b) => a - b);
    let completed = 0;
    let collected = 0n;
    for (const member of mature) {
      let paid = false;
      for (const order of byJourney.get(member.journeyId) ?? []) {
        const capture = order.outcomes.find(event => (event.kind === "PAYMENT_PAID" || event.kind === "COD_COLLECTED") &&
          +event.at <= +member.assignedAt + plan.collectionDays * day && event.amountMinor !== null &&
          Number.isSafeInteger(event.amountMinor) && event.amountMinor >= 0);
        if (!capture || capture.amountMinor === null) continue;
        collected += BigInt(capture.amountMinor);
        paid = true;
      }
      if (paid) completed++;
    }
    const matureOrders = fulfillmentMature.flatMap(member => byJourney.get(member.journeyId) ?? []);
    const outcomeCount = (kind: CommerceOutcome["kind"]) => matureOrders.filter(order => order.outcomes.some(event => event.kind === kind)).length;
    const delivered = outcomeCount("ORDER_DELIVERED");
    const returns = matureOrders.filter(order => order.outcomes.some(event =>
      event.kind === "ORDER_DELIVERED") && order.outcomes.some(event => event.kind === "RETURN_RECEIVED")).length;
    const contribution = contributionProfit(matureOrders);
    const checkouts = assigned.filter(member => checkout.has(member.id)).length;
    const checkoutErrors = assigned.filter(member => checkoutFailed.has(member.id)).length;
    return {
      variant, assigned: assigned.length, exposed: assigned.filter(member => exposure.has(member.id)).length, versions,
      mature: mature.length, awaitingCollection: assigned.length - mature.length, completed, conversionInterval: wilson(completed, mature.length),
      collected, fulfillmentMature: fulfillmentMature.length, awaitingFulfillment: assigned.length - fulfillmentMature.length,
      matureOrders: matureOrders.length, delivered, deliveryInterval: wilson(delivered, matureOrders.length), returns, returnInterval: wilson(returns, delivered),
      codCollected: outcomeCount("COD_COLLECTED"), codRemitted: outcomeCount("COD_REMITTED"),
      contribution, latencySamples: latency.length, p95Ms: latency[Math.ceil(latency.length * 0.95) - 1] ?? null,
      checkouts, checkoutErrors, checkoutErrorInterval: wilson(checkoutErrors, checkouts),
      paymentFailures: input.providerFailureAvailable || paymentFailed.size > 0
        ? assigned.filter(member => paymentFailed.has(member.id)).length : null,
    };
  };
  const control = result("control");
  const personalized = result("personalized");
  // Two 97.5% marginal Wilson intervals form a conservative 95% comparison range.
  const baseline = wilson(control.completed, control.mature, 2.2414);
  const treatment = wilson(personalized.completed, personalized.mature, 2.2414);
  const liftInterval = baseline && treatment ? [treatment[0] - baseline[1], treatment[1] - baseline[0]] as const : null;
  const balanced = Math.abs(control.assigned - personalized.assigned) <= 3 * Math.sqrt(input.members.length);
  const enough = [control, personalized].every(arm => arm.mature >= plan.minMaturePerArm && arm.completed >= plan.minCompletedPerArm);
  const homepageConfigs = [...new Set([...exposure.values()].flatMap(item => item.homepageConfig ? [item.homepageConfig] : []))].sort();
  const hasMixedVersions = homepageConfigs.length > 1 || control.versions.length > 1 ||
    personalized.versions.filter(version => version !== "featured-v1").length > 1;
  return {
    control, personalized, liftInterval, balanced, homepageConfigs, hasMixedVersions,
    interpretation: !enough ? "insufficient-sample" : !balanced ? "allocation-review" : hasMixedVersions ? "configuration-review" : "ready-for-review",
    evidence: [...evidence].sort(),
  } as const;
}
