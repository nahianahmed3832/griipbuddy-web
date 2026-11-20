import type { CommerceOutcome } from "./outcomes.ts";
import { contributionProfit, type ContributionRecord } from "./contribution.ts";

type Observation = {
  kind: string;
  at: Date;
  journeyId: string;
  sessionId: string | null;
  productId: string | null;
  details: unknown;
};

type LinkedOrder = {
  createdAt: Date;
  measurement: { journeyId: string; sessionId: string | null } | null;
};

export type ReportOrderSummary = {
  subtotalMinor: number | null;
  discountMinor: number | null;
  deliveryMinor: number | null;
  payment: { method: string; status: string } | null;
  outcomes: CommerceOutcome[];
  currency?: string;
  updatedAt?: Date;
  contributionEvidence?: ContributionRecord | null;
};

export function marketCommerce(orders: ReportOrderSummary[], providerFailures: number | null, paymentWindow?: { fromAt: Date; until: Date }) {
  const finance = {
    merchandiseBooked: 0n, deliveryCharged: 0n, codCollected: 0n, prepaidCaptured: 0n,
    remittanceNet: 0n, remittanceDeductions: 0n, remittanceOrders: 0,
    merchandiseCovered: 0, deliveryCovered: 0,
  };
  const evidence = { production: 0, sandbox: 0, fixture: 0, unknown: 0 };
  let cancelled = 0, delivered = 0, deliveryRefused = 0, returned = 0;
  let codOrders = 0, codAwaiting = 0, codCollected = 0, paid = 0, paidInWindow = 0, refunded = 0;
  for (const order of orders) {
    const byKind = new Map(order.outcomes.map(event => [event.kind, event]));
    evidence[byKind.get("ORDER_ACCEPTED")?.evidence ?? "unknown"]++;
    if (byKind.has("ORDER_CANCELLED")) cancelled++;
    if (byKind.has("ORDER_DELIVERED")) delivered++;
    if (byKind.has("ORDER_REFUSED")) deliveryRefused++;
    if (byKind.has("RETURN_RECEIVED")) returned++;
    if (byKind.has("ORDER_REFUNDED")) refunded++;

    if (order.payment?.method === "COD") {
      codOrders++;
      if (order.payment.status === "AWAITING_COLLECTION") codAwaiting++;
    }
    const collected = byKind.get("COD_COLLECTED");
    if (collected?.amountMinor != null) {
      codCollected++;
      finance.codCollected += BigInt(collected.amountMinor);
    }
    const captured = byKind.get("PAYMENT_PAID");
    if (captured?.amountMinor != null) {
      paid++;
      if (!paymentWindow || (captured.at >= paymentWindow.fromAt && captured.at < paymentWindow.until)) paidInWindow++;
      finance.prepaidCaptured += BigInt(captured.amountMinor);
    }
    const remittance = byKind.get("COD_REMITTED");
    if (remittance?.amountMinor != null && remittance.deductionsMinor != null) {
      finance.remittanceOrders++;
      finance.remittanceNet += BigInt(remittance.amountMinor);
      finance.remittanceDeductions += BigInt(remittance.deductionsMinor);
    }
    if (order.subtotalMinor !== null && order.discountMinor !== null) {
      finance.merchandiseBooked += BigInt(order.subtotalMinor - order.discountMinor);
      finance.merchandiseCovered++;
    }
    if (order.deliveryMinor !== null) {
      finance.deliveryCharged += BigInt(order.deliveryMinor);
      finance.deliveryCovered++;
    }
  }

  return {
    accepted: orders.length, cancelled, delivered, deliveryRefused, returned,
    codOrders, codAwaiting, codCollected, paid, paidInWindow, refunded, providerFailures, finance, evidence,
    contribution: contributionProfit(orders),
  };
}

const qualifying = [
  "PRODUCT_CLICK", "PRODUCT_VIEW", "SEARCH", "SEARCH_FILTER", "WISHLIST_ADD", "CART_ADD", "CHECKOUT_START",
] as const;
const qualifyingKinds: ReadonlySet<string> = new Set(qualifying);

export const funnelKinds = [...qualifying, "CHECKOUT_FAILURE"] as const;

const sessionKey = (journeyId: string, sessionId: string) => `${journeyId}:${sessionId}`;

function searchResult(details: unknown) {
  if (!details || typeof details !== "object" || !("resultCount" in details)) return null;
  const count = details.resultCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
  const term = "query" in details && typeof details.query === "string" ? details.query : null;
  return { term, zero: count === 0 };
}

// Receives only deduplicated, consented events for one market and dataset, in timestamp order.
export function marketBehavior(observations: Observation[], orders: LinkedOrder[], window: { fromAt: Date; until: Date }) {
  const inWindow = (at: Date) => at >= window.fromAt && at < window.until;
  const sessions = new Map<string, Observation[]>();
  const terms = new Map<string, { searches: number; zeros: number; sessions: Set<string> }>();
  let searches = 0, zeros = 0, filterChanges = 0, checkoutFailures = 0;

  for (const event of observations) {
    const key = event.sessionId ? sessionKey(event.journeyId, event.sessionId) : null;
    if (inWindow(event.at)) {
      if (event.kind === "SEARCH") {
        const result = searchResult(event.details);
        if (result) {
          searches++;
          if (result.zero) zeros++;
          if (result.term) {
            const term = terms.get(result.term) ?? { searches: 0, zeros: 0, sessions: new Set<string>() };
            term.searches++;
            if (result.zero) term.zeros++;
            if (key) term.sessions.add(key);
            terms.set(result.term, term);
          }
        }
      } else if (event.kind === "SEARCH_FILTER") filterChanges++;
      else if (event.kind === "CHECKOUT_FAILURE") checkoutFailures++;
    }
    if (!key || !qualifyingKinds.has(event.kind)) continue;
    const events = sessions.get(key) ?? [];
    events.push(event);
    sessions.set(key, events);
  }

  let qualified = 0, productViews = 0, productToCart = 0;
  const checkouts = new Map<string, Date>();
  for (const [key, events] of sessions) {
    if (!inWindow(events[0].at)) continue;
    qualified++;
    const viewed = new Set<string>();
    let converted = false;
    for (const event of events) {
      if (event.kind === "PRODUCT_VIEW" && event.productId) viewed.add(event.productId);
      if (event.kind === "CART_ADD" && event.productId && viewed.has(event.productId)) converted = true;
      if (event.kind === "CHECKOUT_START" && !checkouts.has(key)) checkouts.set(key, event.at);
    }
    if (viewed.size) productViews++;
    if (converted) productToCart++;
  }

  const converted = new Set<string>();
  for (const order of orders) {
    const link = order.measurement;
    if (!link?.sessionId) continue;
    const key = sessionKey(link.journeyId, link.sessionId);
    const checkoutAt = checkouts.get(key);
    if (checkoutAt && checkoutAt <= order.createdAt) converted.add(key);
  }

  return {
    qualified, productViews, productToCart, checkoutStarts: checkouts.size, checkoutToOrder: converted.size,
    checkoutFailures, searches, zeros, filterChanges,
    terms: [...terms.entries()]
      .sort(([a, left], [b, right]) => right.searches - left.searches || right.zeros - left.zeros || a.localeCompare(b))
      .map(([term, { searches, zeros, sessions }]) => [term, { searches, zeros, sessions: sessions.size }] as const),
  };
}
