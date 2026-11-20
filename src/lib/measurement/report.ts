import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";
import { marketConfiguration } from "../market-config.ts";
import { acquisitionCampaign } from "./campaign.ts";
import { fixtureConversionPreview } from "./conversion-preview.ts";
import {
  cohort, cohortWindow, eligiblePath, ga4BookedOrder, journeyDays, measurementRetentionDays, type CommerceMeasurementRow,
} from "./domain.ts";
import { funnelKinds, marketBehavior, marketCommerce } from "./market-summary.ts";
import { commerceOutcomeSelect, failedPaymentAttempts, orderMeasurement, projectCommerceOutcomes } from "./outcomes.ts";
import { marketOrderForecast } from "./forecast.ts";
import { bridgeOrderForReport, bridgeOrdersForReport } from "./bridge-report.ts";

const day = 86_400_000;
const maxBatch = 10_000;

const eventFields = {
  id: true, kind: true, at: true, variantId: true, productId: true, quantity: true, campaign: true,
  journeyId: true, sessionId: true, details: true, amountMinor: true, currency: true,
} as const;
type DebugRecord = {
  id: string; at: Date; kind: string; campaign: string | null;
  variantId: string | null; quantity: number | null;
  currency: CommerceMeasurementRow["currency"] | null; amountMinor: number | null;
  source: string | null;
};
type DebugSource = Omit<DebugRecord, "campaign" | "variantId" | "quantity" | "source"> & Partial<Pick<DebugRecord, "variantId" | "quantity" | "source">>;

function debugRecord(source: DebugSource, campaign: string | null): DebugRecord {
  const { id, at, kind, variantId = null, quantity = null, currency, amountMinor, source: origin = null } = source;
  return { id, at, kind, campaign, variantId, quantity, currency, amountMinor, source: origin };
}

type Totals = { booked: bigint; collected: bigint; collectionOrders: number; acceptedOrders: number };
type Source = { product: number; cart: number; checkout: number; accepted: number; orders: number; promotedOrders: number };

export async function acquisitionReport(input: {
  marketId: MarketId; test: boolean; from?: string; to?: string; now?: Date;
}) {
  const now = input.now ?? new Date();
  const market = marketConfiguration(input.marketId);
  const window = cohortWindow(now, input.from, input.to, market.timeZone);
  const cutoff = new Date(Math.min(+now, +window.until + journeyDays * day));
  const oldest = new Date(Math.max(+now - measurementRetentionDays * day, +window.fromAt - journeyDays * day));
  const eventScope = {
    marketId: input.marketId, journey: { test: input.test, grantedAt: { gte: new Date(+now - measurementRetentionDays * day) } },
  };
  const result = await getDb().$transaction(async db => {
    const observations = await db.measurementEvent.findMany({
      where: { ...eventScope, kind: { in: [...funnelKinds] }, at: { gte: oldest, lte: cutoff } },
      orderBy: [{ at: "asc" }, { id: "asc" }], take: maxBatch + 1, select: eventFields,
    });
    const recent = await db.measurementEvent.findMany({
      where: { ...eventScope, at: { gte: window.fromAt, lt: window.until, lte: now } },
      orderBy: [{ at: "desc" }, { id: "asc" }], take: 60, select: eventFields,
    });
    const orders = await db.order.findMany({
      where: { marketId: input.marketId, measurementTest: input.test, createdAt: { gte: window.fromAt, lte: cutoff } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: maxBatch + 1, select: commerceOutcomeSelect,
    });
    const bridged = await bridgeOrdersForReport(db, { marketId: input.marketId, test: input.test,
      fromAt: window.fromAt, through: cutoff, take: maxBatch + 1 });
    const failures = await failedPaymentAttempts(db, {
      marketId: input.marketId, test: input.test, fromAt: window.fromAt,
      until: new Date(Math.min(+now, +window.until)), take: maxBatch + 1,
    });
    const unclassified = await db.order.count({
      where: { marketId: input.marketId, measurementTest: null, createdAt: { gte: window.fromAt, lt: window.until } },
    });
    const forecast = await marketOrderForecast(db, market, input.test, now);
    return { observations, recent, orders, bridged, failures, unclassified, forecast };
  }, { isolationLevel: "RepeatableRead", timeout: 12_000 });

  if (result.observations.length > maxBatch || result.orders.length + result.bridged.length > maxBatch || result.failures.length > maxBatch) {
    return { kind: "window-too-large" as const, window, now };
  }
  const { observations, recent, failures, unclassified } = result;
  const bridged = result.bridged.map(order => bridgeOrderForReport(order, now));
  const orders = [
    ...result.orders.map(order => ({ ...order, native: order, measurement: orderMeasurement(order), outcomes: projectCommerceOutcomes(order, now) })),
    ...bridged,
  ].sort((left, right) => +left.createdAt - +right.createdAt || left.id.localeCompare(right.id));
  const behavior = marketBehavior(observations, orders, window);
  const periodOrders = orders.filter(order => order.createdAt < window.until);
  const onlineEvidence = failures.length > 0 || market.payments.some(entry => entry.enabled &&
    entry.method !== "COD" && entry.evidence === (input.test ? "sandbox" : "production"));
  const commerce = marketCommerce(periodOrders, onlineEvidence ? failures.length : null, window);
  const bridgedInWindow = bridged.filter(order => order.createdAt < window.until);
  const bridgeCommerce = marketCommerce(bridgedInWindow, null);
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
  const debug = recent.map(event => debugRecord(event,
    event.campaign ?? journeys.get(event.journeyId)?.find(row => row.kind === "PRODUCT_VIEW")?.campaign ?? null));
  for (const order of bridgedInWindow) {
    for (const event of order.outcomes) {
      const campaign = event.journeyId && journeys.get(event.journeyId)?.find(row => row.kind === "PRODUCT_VIEW")?.campaign;
      debug.push(debugRecord({ ...event, source: order.authority }, campaign || null));
    }
  }
  for (const event of failures) {
    if (event.journeyId) debug.push(debugRecord(event, null));
  }
  let orderPeriodTotal = 0, unmatched = 0, matchedOutsideCohort = 0;
  let matched = 0, cancelled = 0, delivered = 0, shipped = 0, awaitingCod = 0;
  let sampleOrder: ReturnType<typeof ga4BookedOrder> = null;
  let sampleConfirmation: ReturnType<typeof fixtureConversionPreview> = null;
  const fixturePreview = input.test && (localDatabase() === "griipbuddy_test" || developmentAcceptanceDatabase());
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
    let wasCancelled = false, wasCollected = false;
    for (const event of order.outcomes) {
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
      if (order.native) {
        debug.push(debugRecord(event, included.product.campaign));
        if (fixturePreview) sampleConfirmation ??= fixtureConversionPreview(event, input.marketId);
      }
    }
    if (order.fulfillmentStatus === "DELIVERED") delivered++;
    if (order.fulfillmentStatus === "SHIPPED") shipped++;
    if (!wasCancelled && !wasCollected && order.payment?.status === "AWAITING_COLLECTION") awaitingCod++;
    if (input.test && order.native) sampleOrder = ga4BookedOrder(order.native, now, true);
  }
  const funnel = Array.from(sources.values()).reduce((sum, total) => ({
    product: sum.product + total.product, cart: sum.cart + total.cart, checkout: sum.checkout + total.checkout,
    accepted: sum.accepted + total.accepted,
  }), { product: 0, cart: 0, checkout: 0, accepted: 0 });

  return {
    kind: "report" as const, window, now, cutoff, funnel, sources, matched, cancelled, delivered, shipped, awaitingCod,
    behavior, commerce, bridgeCommerce, forecast: result.forecast,
    currencies, unmatched, orderPeriodTotal, unclassified, matchedOutsideCohort, sampleOrder, sampleConfirmation,
    latestObservation: recent[0]?.at,
    debug: debug.sort((a, b) => +b.at - +a.at || a.id.localeCompare(b.id)).slice(0, 60),
  };
}
