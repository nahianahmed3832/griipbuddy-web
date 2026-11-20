import { z } from "zod";
import { type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { publicProductScope } from "../catalog/repository.ts";
import { connectedOfferScope } from "../commerce/market-offers.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { localDatabase } from "../db/local.ts";
import { marketDay, shiftCalendarDay } from "../market-calendar.ts";
import { isMarketSelectable, marketConfiguration, marketForStorefrontOrigin } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { sellerOrderRange } from "../marketplace/seller-order-range.ts";
import { commerceOutcomeSelect, failedPaymentAttempts, projectCommerceOutcomes } from "../measurement/outcomes.ts";
import { measurementRetentionDays } from "../measurement/domain.ts";
import { safeSearchQuery } from "../measurement/search-privacy.ts";
import { staffMarketIds } from "./market-access.ts";

const limit = 5000;
const pageSize = 30;
const maxDays = 366;
const distinctSearchFloor = 3;

export const reportViews = {
  daily: "Daily totals", activity: "Order and payment activity", organizations: "In-house and seller sales",
  products: "Product performance", stock: "Physical stock", demand: "Search and wishlist demand",
} as const;
export type ReportView = keyof typeof reportViews;

const queryInput = z.strictObject({
  market: z.custom<MarketId>(isMarketSelectable).optional(), from: z.string().optional(), to: z.string().optional(),
  mode: z.enum(["operating", "fixture"]).optional(), view: z.enum(["daily", "activity", "organizations", "products", "stock", "demand"]).default("daily"),
  compare: z.enum(["previous", "none"]).optional(),
  page: z.string().regex(/^[1-9][0-9]{0,3}$/).transform(Number).optional(),
  location: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/).optional(),
});

export class OperationsReportError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function reportQuery(raw: unknown, selected: MarketId, origin: string, now = new Date()) {
  const parsed = queryInput.safeParse(raw);
  if (!parsed.success) throw new OperationsReportError("Choose valid report filters.", 400);
  const bound = marketForStorefrontOrigin(origin);
  const marketId = parsed.data.market ?? bound ?? selected;
  const range = sellerOrderRange(parsed.data.from, parsed.data.to, now, marketId);
  const today = marketDay(now, marketConfiguration(marketId).timeZone);
  if ((bound && bound !== marketId) || !isMarketSelectable(marketId)) {
    throw new OperationsReportError("This operating market is unavailable.", 404);
  }
  if (!range || range.to > today || Date.parse(range.to) - Date.parse(range.from) >= maxDays * 86_400_000) {
    throw new OperationsReportError("Choose a report period of at most 366 days ending today or earlier.", 400);
  }
  const fixture = localDatabase() === "griipbuddy_test";
  if (parsed.data.mode === "fixture" && !fixture) {
    throw new OperationsReportError("The fixture report is available in a dedicated local database.", 404);
  }
  return { range, marketId, mode: parsed.data.mode ?? (fixture ? "fixture" : "operating"), now, view: parsed.data.view,
    page: parsed.data.page ?? 1, location: parsed.data.location, compare: parsed.data.compare ?? "none", fixture };
}

export type ReportQuery = ReturnType<typeof reportQuery>;

function within(date: Date | null | undefined, bounds: { gte: Date; lt: Date }) {
  return Boolean(date && date >= bounds.gte && date < bounds.lt);
}

function checkSize(rows: readonly unknown[]) {
  if (rows.length > limit) throw new OperationsReportError("The report exceeds the row limit. Narrow the period or warehouse.", 422);
}

const orderSelect = {
  ...commerceOutcomeSelect, reference: true, shopperId: true, status: true,
  items: { select: { ...commerceOutcomeSelect.items.select, sku: true, productName: true, currency: true,
    lineTotalMinor: true, marketplaceShopId: true, marketplaceShopNameSnapshot: true,
    variant: { select: { product: { select: { id: true, brand: true, department: { select: { name: true } } } } } } } },
  codRemittances: { ...commerceOutcomeSelect.codRemittances, orderBy: { createdAt: "asc" } },
  cases: { select: { ...commerceOutcomeSelect.cases.select, kind: true,
    refund: { select: { state: true, currency: true, amountMinor: true, confirmedAt: true, providerRefundId: true } } } },
} satisfies Prisma.OrderSelect;

type Activity = { orderId: string | null; reference: string | null; kind: string; at: Date; amountMinor: number | null };
const reportKinds = {
  ORDER_ACCEPTED: "Placed", ORDER_CANCELLED: "Cancelled", ORDER_DELIVERED: "Delivered",
  PAYMENT_PAID: "Online payment confirmed", COD_COLLECTED: "COD collected", COD_REMITTED: "Carrier remittance matched",
  ORDER_REFUNDED: "Refund confirmed", ORDER_REFUSED: "Delivery refusal recorded",
  RETURN_REQUESTED: "Return requested", RETURN_RECEIVED: "Return received", PAYMENT_FAILED: "Online payment failed",
} as const;
type Totals = ReturnType<typeof emptyTotals>;

function emptyTotals() {
  return { orders: 0, bookedMinor: 0, cancellations: 0, delivered: 0, onlinePayments: 0, onlineMinor: 0,
    codCollections: 0, codMinor: 0, remittances: 0, remittedMinor: 0, refunds: 0, refundedMinor: 0, refused: 0,
    returnRequests: 0, receivedReturns: 0, paymentFailures: 0 };
}

function addOutcome(totals: Totals, kind: string, amount: number | null) {
  const value = amount ?? 0;
  switch (kind) {
    case "ORDER_ACCEPTED": totals.orders++; totals.bookedMinor += value; break;
    case "ORDER_CANCELLED": totals.cancellations++; break;
    case "ORDER_DELIVERED": totals.delivered++; break;
    case "PAYMENT_PAID": totals.onlinePayments++; totals.onlineMinor += value; break;
    case "COD_COLLECTED": totals.codCollections++; totals.codMinor += value; break;
    case "COD_REMITTED": totals.remittances++; totals.remittedMinor += value; break;
    case "ORDER_REFUNDED": totals.refunds++; totals.refundedMinor += value; break;
    case "ORDER_REFUSED": totals.refused++; break;
    case "RETURN_REQUESTED": totals.returnRequests++; break;
    case "RETURN_RECEIVED": totals.receivedReturns++; break;
    case "PAYMENT_FAILED": totals.paymentFailures++; break;
  }
}

type SaleRow = { key: string; label: string; units: number; merchandiseMinor: number; orders: Set<string>;
  sku?: string; brand?: string; department?: string };
type Projection = ReturnType<typeof projectCommerceOutcomes>;

function addSale(rows: Map<string, SaleRow>, key: string, labels: Pick<SaleRow, "label" | "sku" | "brand" | "department">, orderId: string,
  units: number, amountMinor: number) {
  const row = rows.get(key) ?? { ...labels, key, units: 0, merchandiseMinor: 0, orders: new Set<string>() };
  row.units += units;
  row.merchandiseMinor += amountMinor;
  row.orders.add(orderId);
  rows.set(key, row);
}

function sortedSales(rows: Map<string, SaleRow>) {
  return [...rows.values()].sort((a, b) => b.merchandiseMinor - a.merchandiseMinor || a.key.localeCompare(b.key))
    .map(({ orders, ...row }) => ({ ...row, orders: orders.size }));
}

function orderOutcomes(order: Prisma.OrderGetPayload<{ select: typeof orderSelect }>, cutoff: Date): Projection {
  const cases = order.cases.filter(row => row.kind === "RETURN" || row.kind === "EXCHANGE");
  const recordedRefundId = order.attempt.paypal?.refundId;
  const duplicateWholeRefund = recordedRefundId && order.cases.some(({ refund }) =>
    refund?.providerRefundId === recordedRefundId && refund.state === "CONFIRMED" && refund.currency === order.currency && refund.confirmedAt);
  return projectCommerceOutcomes({ ...order, cases }, cutoff).filter(outcome => !duplicateWholeRefund || outcome.kind !== "ORDER_REFUNDED");
}

async function orderData(db: DbReader, input: ReportQuery, granularity: boolean) {
  const { range, marketId, mode, now } = input;
  const { currency, timeZone } = marketConfiguration(marketId);
  const dates = { gte: range.start, lt: new Date(Math.min(+range.endExclusive, +now + 1)) };
  const classification: Prisma.OrderWhereInput = mode === "fixture"
    ? { OR: [{ commerceEvidence: { in: ["fixture", "sandbox"] } }, { commerceEvidence: null, measurementTest: true }] }
    : { commerceEvidence: "production", measurementTest: { not: true } };
  // The OR preserves old-order money and returns recorded inside the current period.
  const [orders, unclassified, failed] = await Promise.all([
    db.order.findMany({ where: { AND: [{ marketId, currency, createdAt: { lt: dates.lt } }, classification, {
      OR: [{ createdAt: dates }, { cancelledAt: dates }, { payment: { is: { OR: [{ createdAt: dates }, { collectedAt: dates }] } } },
        { events: { some: { type: "STATUS_CHANGED", status: "DELIVERED", createdAt: dates } } },
        { bangladeshShipment: { is: { events: { some: { status: "REFUSED", recordedAt: dates } } } } },
        { bangladeshRefusedParcelReceipt: { is: { receivedAt: dates } } },
        { parcels: { some: { OR: [{ receivedAt: dates }, { events: { some: { status: "REFUSED", recordedAt: dates } } }] } } },
        { codRemittances: { some: { status: "MATCHED", createdAt: dates } } },
        { cases: { some: { OR: [{ createdAt: dates }, { returnReceivedAt: dates }, { refund: { state: "CONFIRMED", confirmedAt: dates } }] } } },
      ],
    }] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limit + 1, select: orderSelect }),
    db.order.count({ where: { marketId, currency, createdAt: dates, commerceEvidence: null, measurementTest: null } }),
    failedPaymentAttempts(db, { marketId, test: mode === "fixture", fromAt: dates.gte, until: dates.lt, take: limit + 1 }),
  ]);
  checkSize(orders);
  checkSize(failed);
  const activity: Activity[] = [];
  const buckets = new Map<string, Totals>();
  const registered = new Set<string>();
  const products = new Map<string, SaleRow>();
  const variants = new Map<string, SaleRow>();
  const organizations = new Map<string, SaleRow>();
  const sum = emptyTotals();
  let guestOrders = 0, placedDelivered = 0;
  const observe = (outcome: Activity) => {
    if (!within(outcome.at, dates)) return;
    if (granularity) activity.push({ orderId: outcome.orderId, reference: outcome.reference, kind: outcome.kind,
      at: outcome.at, amountMinor: outcome.amountMinor });
    const day = marketDay(outcome.at, timeZone);
    const bucket = buckets.get(day) ?? emptyTotals();
    buckets.set(day, bucket);
    addOutcome(sum, outcome.kind, outcome.amountMinor);
    addOutcome(bucket, outcome.kind, outcome.amountMinor);
  };
  for (const order of orders) {
    const outcomes = orderOutcomes(order, now);
    for (const outcome of outcomes) observe({ ...outcome, reference: order.reference });
    for (const { refund } of order.cases) {
      if (refund?.state === "CONFIRMED" && refund.currency === currency && refund.confirmedAt && refund.amountMinor > 0 &&
        refund.confirmedAt >= order.createdAt) {
        observe({ kind: "ORDER_REFUNDED", at: refund.confirmedAt, orderId: order.id, reference: order.reference, amountMinor: refund.amountMinor });
      }
    }
    if (!within(order.createdAt, dates)) continue;
    if (order.shopperId) registered.add(order.shopperId);
    else guestOrders++;
    if (outcomes.some(row => row.kind === "ORDER_DELIVERED")) placedDelivered++;
    for (const line of order.items) {
      if (line.currency !== currency) continue;
      const product = line.variant.product;
      const shopId = line.marketplaceShopId ?? storeShop.id;
      const label = shopId === storeShop.id ? "GriipBuddy in-house" : line.marketplaceShopNameSnapshot ?? "Seller " + shopId;
      addSale(organizations, shopId, { label }, order.id, line.quantity, line.lineTotalMinor);
      const labels = { label: line.productName, brand: product.brand ?? undefined, department: product.department?.name };
      addSale(products, line.productIdSnapshot ?? product.id, labels, order.id, line.quantity, line.lineTotalMinor);
      addSale(variants, line.variantId, { ...labels, sku: line.sku }, order.id, line.quantity, line.lineTotalMinor);
    }
  }
  for (const failure of failed) observe({ ...failure, reference: null });
  return { daily: [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, ...values })),
    totals: sum, registered: registered.size, guestOrders, placedDelivered, unclassified, failureEvidence: mode === "fixture",
    activity: activity.sort((a, b) => +b.at - +a.at || a.kind.localeCompare(b.kind) || (a.orderId ?? "").localeCompare(b.orderId ?? "")),
    organizations: sortedSales(organizations), products: sortedSales(products), variants: sortedSales(variants) };
}

async function productCount(db: DbReader, input: ReportQuery) {
  return db.product.count({ where: { ...(input.mode === "operating" && { demo: false }), OR: [
    publicProductScope(input.marketId), { variants: { some: { offers: { some: { ...connectedOfferScope(input.marketId), eligible: true } } } } },
  ] } });
}

async function stockRows(db: DbReader, input: ReportQuery) {
  const marketService = { active: true, marketServices: { some: { marketId: input.marketId, active: true } } };
  const [rows, locations] = await Promise.all([
    db.inventoryPool.findMany({ where: { ...(input.location && { locationId: input.location }), location: marketService,
      variant: { managedInventory: true, ...(input.mode === "operating" && { product: { demo: false } }) } },
      orderBy: [{ locationId: "asc" }, { ownerId: "asc" }, { variantId: "asc" }], take: limit + 1,
      select: { id: true, onHand: true, reserved: true, lowStockThreshold: true, updatedAt: true, location: { select: { name: true } },
        owner: { select: { name: true } }, variant: { select: { sku: true, product: { select: { name: true } } } } } }),
    db.dispatchLocation.findMany({ where: marketService, orderBy: [{ name: "asc" }, { id: "asc" }], take: limit + 1,
      select: { id: true, name: true } }),
  ]);
  checkSize(rows);
  checkSize(locations);
  if (input.location && !locations.some(row => row.id === input.location)) {
    throw new OperationsReportError("This warehouse is unavailable in the selected market.", 404);
  }
  return { locations, rows: rows.map(row => ({ id: row.id, location: row.location.name, organization: row.owner.name,
    sku: row.variant.sku, product: row.variant.product.name, onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved,
    threshold: row.lowStockThreshold, updatedAt: row.updatedAt })) };
}

async function demandData(db: DbReader, input: ReportQuery) {
  const retained = new Date(+input.now - measurementRetentionDays * 86_400_000);
  const rows = await db.measurementEvent.findMany({ where: { marketId: input.marketId,
    at: { gte: new Date(Math.max(+retained, +input.range.start)), lt: input.range.endExclusive, lte: input.now },
    kind: { in: ["SEARCH", "WISHLIST_ADD"] }, schemaVersion: 1, sessionId: { not: null },
    journey: { test: input.mode === "fixture", automated: false, grantedAt: { gte: retained } } },
    take: limit + 1, orderBy: [{ at: "asc" }, { id: "asc" }], select: { kind: true, sessionId: true, details: true, productId: true } });
  checkSize(rows);
  let searches = 0, zeroResults = 0;
  const queries = new Map<string, { sessions: Set<string>; zero: number }>();
  const wishlists = new Map<string, Set<string>>();
  for (const { kind, sessionId, details, productId } of rows) {
    if (!sessionId) continue;
    if (kind === "WISHLIST_ADD") {
      if (!productId) continue;
      const sessions = wishlists.get(productId) ?? new Set<string>();
      sessions.add(sessionId);
      wishlists.set(productId, sessions);
      continue;
    }
    if (!details || typeof details !== "object" || Array.isArray(details) ||
        typeof details.resultCount !== "number" || !Number.isInteger(details.resultCount) || details.resultCount < 0) continue;
    searches++;
    const isZero = details.resultCount === 0;
    if (isZero) zeroResults++;
    const query = safeSearchQuery(typeof details.query === "string" ? details.query : undefined);
    if (!query) continue;
    const row = queries.get(query) ?? { sessions: new Set<string>(), zero: 0 };
    row.sessions.add(sessionId);
    if (isZero) row.zero++;
    queries.set(query, row);
  }
  const listing = await db.product.findMany({ where: { id: { in: [...wishlists.keys()] }, OR: [
    publicProductScope(input.marketId), { variants: { some: { offers: { some: { ...connectedOfferScope(input.marketId), eligible: true } } } } },
  ] }, select: { id: true, name: true } });
  return { oldest: retained, searches, zeroResults, terms: [...queries].filter(([, row]) => row.sessions.size >= distinctSearchFloor)
      .map(([term, row]) => ({ term, sessions: row.sessions.size, zero: row.zero })).sort((a, b) => b.sessions - a.sessions || a.term.localeCompare(b.term)),
    wishlist: listing.map(({ id, name }) => ({ id, name, sessions: wishlists.get(id)?.size ?? 0 }))
      .sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id)) };
}

async function previousPeriod(db: DbReader, input: ReportQuery) {
  const days = Math.round((Date.parse(input.range.to) - Date.parse(input.range.from)) / 86_400_000) + 1;
  const from = shiftCalendarDay(input.range.from, -days);
  const to = shiftCalendarDay(input.range.from, -1);
  const range = from && to ? sellerOrderRange(from, to, input.now, input.marketId) : null;
  if (!range) return null;
  const result = await orderData(db, { ...input, range }, false);
  return { range, totals: result.totals };
}

export async function loadOperationsReport(actorId: string, input: ReportQuery) {
  return getDb().$transaction(async db => {
    const [allowed, operations, actor] = await Promise.all([
      staffMarketIds(actorId, "reporting", db), staffMarketIds(actorId, "operations", db),
      db.staffAccess.findUnique({ where: { userId: actorId }, select: { active: true, role: true } }),
    ]);
    const owner = actor?.active === true && actor.role === "OWNER";
    const activity = operations.includes(input.marketId);
    if (!allowed.includes(input.marketId) || (input.view === "activity" && !activity) || (input.view === "stock" && !owner)) {
      throw new OperationsReportError("This report is unavailable to your account.", 404);
    }
    const [orders, catalogCount, stock, demand] = await Promise.all([
      input.view === "stock" || input.view === "demand" ? null : orderData(db, input, input.view === "activity"),
      input.view === "products" ? productCount(db, input) : null,
      input.view === "stock" ? stockRows(db, input) : null,
      input.view === "demand" ? demandData(db, input) : null,
    ]);
    const comparison = input.view === "daily" && input.compare === "previous" ? await previousPeriod(db, input) : null;
    return { input, allowed, activity, owner, orders, catalogCount, stock, demand, comparison, pageSize };
  }, { isolationLevel: "RepeatableRead", timeout: 12_000 });
}

export type OperationsReport = Awaited<ReturnType<typeof loadOperationsReport>>;
export const activityLabel = (kind: string) => reportKinds[kind as keyof typeof reportKinds] ?? kind;
