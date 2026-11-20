import type { Currency } from "../../config/markets.ts";
import { contributionProfit } from "../measurement/contribution.ts";
import type { CommerceOutcome } from "../measurement/outcomes.ts";
import type { IntelligenceOrder } from "./commerce.ts";
import type { Observation } from "./observations.ts";
import type { IntelligenceMetrics, ProductFinance } from "./types.ts";

const cohortMs = 7 * 86_400_000;
type CostField = "itemCostMinor" | "packagingMinor" | "outboundMinor" | "returnMinor" | "paymentFeesMinor";

export function metricState() {
  return {
    counts: { impressions: 0, productClicks: 0, wishlistAdds: 0, wishlistRemoves: 0, cartAdds: 0, cartUpdates: 0,
      cartRemoves: 0, checkoutErrors: 0, bookedOrders: 0, bookedUnits: 0, discountedUnits: 0, paidOrders: 0, paidUnits: 0,
      cancelledOrders: 0, deliveredOrders: 0, returnedOrders: 0, returnedUnits: 0, codCollectedOrders: 0, codRemittedOrders: 0 },
    placements: new Map<string, number>(), campaigns: new Map<string, { viewers: Set<string>; paid: Set<string> }>(), viewers: new Set<string>(),
    cartSessions: new Set<string>(), checkoutSessions: new Set<string>(), firstView: new Map<string, number>(),
    firstCampaign: new Map<string, string>(),
    viewedThenCart: new Set<string>(), viewedThenCheckout: new Set<string>(), viewedThenPaid: new Set<string>(),
  };
}

export type MetricState = ReturnType<typeof metricState>;
export const sessionKey = (journeyId: string, sessionId: string | null) => `${journeyId}:${sessionId ?? "journey"}`;

function saw(state: MetricState, journeyId: string, sessionId: string | null, at: Date) {
  const start = state.firstView.get(sessionKey(journeyId, sessionId)) ?? state.firstView.get(sessionKey(journeyId, null));
  return start !== undefined && +at >= start && +at - start < cohortMs;
}

export function addObservation(state: MetricState, row: Observation) {
  const key = sessionKey(row.journeyId, row.sessionId);
  switch (row.kind) {
    case "PRODUCT_IMPRESSION": {
      state.counts.impressions++;
      const placement = row.placement ?? "Unclassified placement";
      state.placements.set(placement, (state.placements.get(placement) ?? 0) + 1);
      break;
    }
    case "PRODUCT_CLICK": state.counts.productClicks++; break;
    case "PRODUCT_VIEW": {
      state.viewers.add(row.journeyId);
      const source = row.campaignSource ?? "unrecorded";
      if (!state.firstView.has(key)) {
        state.firstView.set(key, +row.at);
        state.firstCampaign.set(key, source);
      }
      const visits = state.campaigns.get(source) ?? { viewers: new Set<string>(), paid: new Set<string>() };
      visits.viewers.add(row.journeyId);
      state.campaigns.set(source, visits);
      break;
    }
    case "WISHLIST_ADD": state.counts.wishlistAdds++; break;
    case "WISHLIST_REMOVE": state.counts.wishlistRemoves++; break;
    case "CART_ADD": {
      state.counts.cartAdds++;
      state.cartSessions.add(key);
      if (saw(state, row.journeyId, row.sessionId, row.at)) state.viewedThenCart.add(row.journeyId);
      break;
    }
    case "CART_UPDATE": state.counts.cartUpdates++; break;
    case "CART_REMOVE": state.counts.cartRemoves++; break;
    case "CHECKOUT_START": {
      state.checkoutSessions.add(key);
      if (saw(state, row.journeyId, row.sessionId, row.at)) state.viewedThenCheckout.add(row.journeyId);
      break;
    }
    case "CHECKOUT_FAILURE": state.counts.checkoutErrors++; break;
  }
}

export function paidEvent(outcomes: Map<string, CommerceOutcome>) {
  return outcomes.get("PAYMENT_PAID") ?? outcomes.get("COD_COLLECTED");
}

export function addOutcomes(state: MetricState, evidence: Map<string, CommerceOutcome>, lines: IntelligenceOrder["lines"], returned: number | null) {
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (evidence.has("ORDER_ACCEPTED")) {
    state.counts.bookedOrders++;
    state.counts.bookedUnits += units;
    state.counts.discountedUnits += lines.reduce((sum, line) => (line.discountMinor ?? 0) > 0 ? sum + line.quantity : sum, 0);
  }
  const paid = paidEvent(evidence);
  if (paid) {
    state.counts.paidOrders++;
    state.counts.paidUnits += units;
    if (paid.journeyId && saw(state, paid.journeyId, paid.sessionId, paid.at)) {
      state.viewedThenPaid.add(paid.journeyId);
      const source = state.firstCampaign.get(sessionKey(paid.journeyId, paid.sessionId)) ?? state.firstCampaign.get(sessionKey(paid.journeyId, null));
      if (source) state.campaigns.get(source)?.paid.add(paid.journeyId);
    }
  }
  if (evidence.has("ORDER_CANCELLED")) state.counts.cancelledOrders++;
  if (evidence.has("ORDER_DELIVERED")) state.counts.deliveredOrders++;
  if (evidence.has("RETURN_RECEIVED") && (returned === null || returned > 0)) state.counts.returnedOrders++;
  state.counts.returnedUnits += returned ?? 0;
  if (evidence.has("COD_COLLECTED")) state.counts.codCollectedOrders++;
  if (evidence.has("COD_REMITTED")) state.counts.codRemittedOrders++;
}

export function summarizeMetrics(state: MetricState, paymentFailures: number | null = null): IntelligenceMetrics {
  return { ...state.counts, paymentFailures,
    impressionsByPlacement: [...state.placements].map(([placement, count]) => ({ placement, count })).sort((a, b) => b.count - a.count),
    campaignVisits: [...state.campaigns].map(([source, entries]) => ({ source, viewers: entries.viewers.size, paidJourneys: entries.paid.size }))
      .sort((a, b) => b.viewers - a.viewers),
    viewers: state.viewers.size, cartSessions: state.cartSessions.size, checkoutSessions: state.checkoutSessions.size,
    viewedThenCart: state.viewedThenCart.size, viewedThenCheckout: state.viewedThenCheckout.size, viewedThenPaid: state.viewedThenPaid.size,
  };
}

export function financialState() {
  return {
    booked: [] as (bigint | null)[], collected: [] as (bigint | null)[], remitted: [] as (bigint | null)[],
    // Share none of the full-order charges on a mixed basket without a verified allocation.
    reconciliations: [] as { verified: boolean; order: IntelligenceOrder }[],
  };
}

export type FinanceState = ReturnType<typeof financialState>;
const sum = (values: readonly (bigint | null)[]) => values.length && values.every(value => value !== null)
  ? values.reduce<bigint>((total, value) => total + value!, 0n) : null;

export function addFinance(state: FinanceState, order: IntelligenceOrder, outcomes: Map<string, CommerceOutcome>, lines: IntelligenceOrder["lines"]) {
  const exact = lines.length === order.lines.length;
  if (outcomes.has("ORDER_ACCEPTED")) state.booked.push(sum(lines.map(line => line.netMinor === null ? null : BigInt(line.netMinor))));
  const capture = paidEvent(outcomes);
  if (capture) {
    state.collected.push(exact && capture.amountMinor !== null ? BigInt(capture.amountMinor) : null);
    state.reconciliations.push({ verified: exact, order });
  }
  const remitted = outcomes.get("COD_REMITTED");
  if (remitted) state.remitted.push(exact && remitted.amountMinor !== null ? BigInt(remitted.amountMinor) : null);
}

export function summarizeFinance(state: FinanceState, currency: Currency): ProductFinance {
  const result = contributionProfit(state.reconciliations.map(({ verified, order }) => ({
    currency, updatedAt: order.updatedAt, outcomes: order.outcomes, contributionEvidence: verified ? order.verified : null,
  })));
  const missing = new Set(result.missing.map(([name]) => name));
  if (state.reconciliations.some(entry => !entry.verified)) missing.add("Verified allocation of shared order costs");
  const cost = (key: CostField) => sum(state.reconciliations.map(({ verified, order }) => {
    const record = order.verified;
    if (!verified || !record || record.currency !== currency || !order.updatedAt || record.verifiedThrough < order.updatedAt ||
        order.outcomes.some(event => event.at > record.verifiedThrough)) return null;
    const amount = record[key];
    return amount !== null && Number.isSafeInteger(amount) && amount >= 0 ? BigInt(amount) : null;
  }));
  return { bookedMerchandiseMinor: sum(state.booked), collectedMinor: sum(state.collected), remittedMinor: sum(state.remitted),
    itemCostMinor: cost("itemCostMinor"), packagingMinor: cost("packagingMinor"), outboundMinor: cost("outboundMinor"),
    returnMinor: cost("returnMinor"), paymentFeesMinor: cost("paymentFeesMinor"), contributionMinor: result.total,
    completeOrders: result.verified, requiredOrders: state.reconciliations.length, missing: [...missing] };
}
