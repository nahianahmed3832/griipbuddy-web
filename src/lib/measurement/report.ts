import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { acquisitionCampaign } from "./campaign.ts";
import {
  cohort, cohortWindow, eligiblePath, ga4BookedOrder, journeyDays, measurementRetentionDays, projectedOrderEvents, type CommerceMeasurementRow,
} from "./domain.ts";

const day = 86_400_000;
const maxBatch = 10_000;

const eventFields = {
  id: true, kind: true, at: true, variantId: true, productId: true, quantity: true, campaign: true, journeyId: true,
} as const;
const orderFields = {
  id: true, createdAt: true, cancelledAt: true, marketId: true, currency: true, measurementTest: true,
  fulfillmentStatus: true, totalMinor: true, subtotalMinor: true, discountMinor: true, taxMinor: true, deliveryMinor: true,
  items: { select: { variantId: true, quantity: true, unitPriceMinor: true, unitDiscountMinor: true } },
  payment: { select: { method: true, status: true, currency: true, amountMinor: true, collectedAt: true } },
  measurement: { select: { journeyId: true } },
} as const;
type DebugRecord = {
  id: string; at: Date; kind: string; campaign: string | null;
  variantId: string | null; quantity: number | null;
  currency: CommerceMeasurementRow["currency"] | null; amountMinor: number | null;
};
type Totals = { booked: bigint; collected: bigint; collectionOrders: number; acceptedOrders: number };
type Source = { product: number; cart: number; checkout: number; accepted: number; orders: number; promotedOrders: number };

export async function acquisitionReport(input: {
  marketId: MarketId; test: boolean; from?: string; to?: string; now?: Date;
}) {
  const now = input.now ?? new Date();
  const window = cohortWindow(now, input.from, input.to);
  const cutoff = new Date(Math.min(+now, +window.until + journeyDays * day));
  const oldest = new Date(Math.max(+now - measurementRetentionDays * day, +window.fromAt - journeyDays * day));
  const result = await getDb().$transaction(async db => {
    const observations = await db.measurementEvent.findMany({
      where: { marketId: input.marketId, journey: { test: input.test, grantedAt: { gte: new Date(+now - measurementRetentionDays * day) } },
        at: { gte: oldest, lte: cutoff } },
      orderBy: [{ at: "asc" }, { id: "asc" }], take: maxBatch + 1, select: eventFields,
    });
    const orders = await db.order.findMany({
      where: { marketId: input.marketId, measurementTest: input.test, createdAt: { gte: window.fromAt, lte: cutoff } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: maxBatch + 1, select: orderFields,
    });
    const unclassified = await db.order.count({
      where: { marketId: input.marketId, measurementTest: null, createdAt: { gte: window.fromAt, lt: window.until } },
    });
    return { observations, orders, unclassified };
  }, { isolationLevel: "RepeatableRead", timeout: 12_000 });

  if (result.observations.length > maxBatch || result.orders.length > maxBatch) {
    return { kind: "window-too-large" as const, window, now };
  }
  const { observations, orders, unclassified } = result;
  const sources = new Map<string | null, Source>();
  const source = (campaign: string | null) => {
    let total = sources.get(campaign);
    if (!total) {
      total = { product: 0, cart: 0, checkout: 0, accepted: 0, orders: 0, promotedOrders: 0 };
      sources.set(campaign, total);
    }
    return total;
  };
  const journeys = new Map<string, typeof observations>();
  for (const event of observations) {
    const events = journeys.get(event.journeyId) ?? [];
    events.push(event);
    journeys.set(event.journeyId, events);
  }

  const members = new Map<string, NonNullable<ReturnType<typeof cohort>>>();
  for (const [journeyId, events] of journeys) {
    const path = cohort(events);
    if (!path || +path.product.at < +window.fromAt || +path.product.at >= +window.until) continue;
    members.set(journeyId, path);
    const total = source(path.product.campaign);
    total.product++;
    if (path.cart) total.cart++;
    if (path.checkout) total.checkout++;
  }

  const currencies = new Map<string, Totals>();
  const accepted = new Set<string>();
  const debug: DebugRecord[] = observations.filter(event => +event.at >= +window.fromAt).slice(-70).map(event => ({
    ...event, campaign: journeys.get(event.journeyId)?.find(row => row.kind === "PRODUCT_VIEW")?.campaign ?? null,
    currency: null, amountMinor: null,
  }));
  let orderPeriodTotal = 0, unmatched = 0, matchedOutsideCohort = 0;
  let matched = 0, cancelled = 0, delivered = 0, shipped = 0, awaitingCod = 0;
  let sampleOrder: ReturnType<typeof ga4BookedOrder> = null;
  for (const order of orders) {
    const journeyId = order.measurement?.journeyId;
    const path = journeyId ? eligiblePath(journeys.get(journeyId) ?? [], order) : null;
    const included = journeyId && members.has(journeyId) && path;
    if (+order.createdAt < +window.until) {
      orderPeriodTotal++;
      if (!path) unmatched++;
      else if (!included) matchedOutsideCohort++;
    }
    if (!journeyId || !included) continue;
    matched++;
    const total = source(included.product.campaign);
    total.orders++;
    if (order.items.some(item => item.variantId === acquisitionCampaign.variantId)) total.promotedOrders++;
    if (!accepted.has(journeyId)) {
      accepted.add(journeyId);
      total.accepted++;
    }
    const financial = currencies.get(order.currency) ?? { booked: 0n, collected: 0n, acceptedOrders: 0, collectionOrders: 0 };
    currencies.set(order.currency, financial);
    const outcomes = projectedOrderEvents(order, now);
    let wasCancelled = false, wasCollected = false;
    for (const event of outcomes) {
      if (event.kind === "ORDER_ACCEPTED") {
        financial.acceptedOrders++;
        financial.booked += BigInt(event.amountMinor ?? 0);
      } else if (event.kind === "ORDER_CANCELLED") {
        wasCancelled = true;
        cancelled++;
      } else if (event.kind === "COD_COLLECTED") {
        wasCollected = true;
        financial.collectionOrders++;
        financial.collected += BigInt(event.amountMinor ?? 0);
      }
      debug.push({ ...event, campaign: included.product.campaign, quantity: null, variantId: null });
    }
    if (order.fulfillmentStatus === "DELIVERED") delivered++;
    if (order.fulfillmentStatus === "SHIPPED") shipped++;
    if (!wasCancelled && !wasCollected && order.payment?.status === "AWAITING_COLLECTION") awaitingCod++;
    if (input.test) sampleOrder = ga4BookedOrder(order, now, true);
  }
  const funnel = Array.from(sources.values()).reduce((sum, total) => ({
    product: sum.product + total.product, cart: sum.cart + total.cart, checkout: sum.checkout + total.checkout,
    accepted: sum.accepted + total.accepted,
  }), { product: 0, cart: 0, checkout: 0, accepted: 0 });

  return {
    kind: "report" as const, window, now, cutoff, funnel, sources, matched, cancelled, delivered, shipped, awaitingCod,
    currencies, unmatched, orderPeriodTotal, unclassified, matchedOutsideCohort, sampleOrder,
    latestObservation: observations.at(-1)?.at,
    debug: debug.sort((a, b) => +b.at - +a.at || a.id.localeCompare(b.id)).slice(0, 60),
  };
}
