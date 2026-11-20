import { Prisma, type MeasurementKind } from "../../generated/prisma/client.ts";
import type { DbReader } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { safeSearchQuery } from "../measurement/search-privacy.ts";
import type { DemandDay, IntelligenceInput, IntelligenceWindow, SearchIntelligence } from "./types.ts";
import { intelligenceBatch } from "./window.ts";

const behaviorKinds = ["PRODUCT_IMPRESSION", "PRODUCT_VIEW", "PRODUCT_CLICK", "SEARCH", "SEARCH_FILTER", "WISHLIST_ADD", "WISHLIST_REMOVE",
  "CART_ADD", "CART_UPDATE", "CART_REMOVE", "CHECKOUT_START", "CHECKOUT_FAILURE"] as const satisfies readonly MeasurementKind[];

export function readIntelligenceBehavior(db: DbReader, input: IntelligenceInput, window: IntelligenceWindow) {
  return db.measurementEvent.findMany({
    where: { marketId: input.marketId, journey: { test: input.test, automated: false },
      kind: { in: [...behaviorKinds] }, at: { gte: window.fromAt, lt: window.until },
      ...((input.productId || input.variantId) && { OR: [{
        ...(input.productId && { productId: input.productId }), ...(input.variantId && { variantId: input.variantId }),
      }, { kind: { in: ["SEARCH", "SEARCH_FILTER", "CHECKOUT_START", "CHECKOUT_FAILURE"] } }] }),
    }, select: { kind: true, at: true, receivedAt: true, quantity: true, productId: true, variantId: true,
      sessionId: true, journeyId: true, details: true, placement: true, campaignSource: true },
    orderBy: [{ at: "asc" }, { id: "asc" }], take: intelligenceBatch + 1,
  });
}

export type Observation = Awaited<ReturnType<typeof readIntelligenceBehavior>>[number];

export type InventorySnapshot = {
  variantId: string;
  day: string;
  observedAt: Date;
  minPrice: number;
  maxPrice: number;
  observed: number;
  sources: string[];
  atLeastOneInStock: boolean | null;
  atLeastOneStockout: boolean | null;
  promoted: boolean;
  priceCoverage: boolean;
  stockCoverage: boolean;
};

export const snapshotDayLimit = 150_000;

export function readIntelligenceSnapshots(db: DbReader, input: IntelligenceInput, window: IntelligenceWindow, variantIds: string[]) {
  if (!variantIds.length) return Promise.resolve([]);
  const market = marketConfiguration(input.marketId);
  // Keep hourly detail in PostgreSQL. The daily rows retain the observed price
  // bounds, changes, and coverage needed by the dashboard and backtests.
  return db.$queryRaw<InventorySnapshot[]>`
    WITH scope AS (
      SELECT "variantId", (timezone(${window.timeZone}, timezone('UTC', "observedAt")))::date AS day,
        "observedAt", "priceMinor", "discountMinor", available, source
      FROM "ProductIntelligenceSnapshot"
      WHERE "marketId" = ${input.marketId}::"MarketCode" AND test = ${input.test}
        AND currency = ${market.currency}::"CurrencyCode" AND "variantId" IN (${Prisma.join(variantIds)})
        AND "observedAt" >= ${window.fromAt} AND "observedAt" < ${window.until}
    ), samples AS (
      SELECT *, "observedAt" - lag("observedAt") OVER days AS price_gap,
        "observedAt" - max("observedAt") FILTER (WHERE available IS NOT NULL) OVER (
          days ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS stock_gap
      FROM scope WINDOW days AS (PARTITION BY "variantId", day ORDER BY "observedAt")
    )
    SELECT "variantId", to_char(day, 'YYYY-MM-DD') AS day, max("observedAt") AS "observedAt",
      min("priceMinor" - "discountMinor") AS "minPrice", max("priceMinor" - "discountMinor") AS "maxPrice",
      count(*)::integer AS observed, array_agg(DISTINCT source) AS sources,
      bool_or(available > 0) AS "atLeastOneInStock", bool_or(available = 0) AS "atLeastOneStockout",
      bool_or("discountMinor" > 0) AS promoted,
      coalesce(count(*) >= 4 AND max("observedAt") - min("observedAt") >= INTERVAL '18 hours'
        AND max(price_gap) <= INTERVAL '8 hours', false) AS "priceCoverage",
      coalesce(count(available) >= 4 AND (max("observedAt") FILTER (WHERE available IS NOT NULL)) -
        (min("observedAt") FILTER (WHERE available IS NOT NULL)) >= INTERVAL '18 hours'
        AND max(stock_gap) FILTER (WHERE available IS NOT NULL) <= INTERVAL '8 hours', false) AS "stockCoverage"
    FROM samples GROUP BY "variantId", day ORDER BY max("observedAt"), "variantId" LIMIT ${snapshotDayLimit + 1}
  `;
}

type Term = { searches: number; searchers: Set<string>; zeroResults: number; reformulations: number };

export function searchIntelligence(observations: Observation[]): SearchIntelligence {
  let searches = 0, zeroResults = 0, filterChanges = 0, reformulations = 0;
  const searchers = new Set<string>();
  const byTerm = new Map<string, Term>();
  const last = new Map<string, { term: string; at: number; zeroResult: boolean }>();
  for (const row of observations) {
    if (row.kind === "SEARCH_FILTER") filterChanges++;
    if (row.kind !== "SEARCH") continue;
    const data = row.details;
    if (!data || typeof data !== "object" || Array.isArray(data) || !Number.isSafeInteger(data.resultCount) || Number(data.resultCount) < 0) continue;
    const term = safeSearchQuery(typeof data.query === "string" ? data.query : undefined);
    const zeroResult = data.resultCount === 0;
    const key = `${row.journeyId}:${row.sessionId ?? "single-measurement-journey"}`;
    searches++;
    if (zeroResult) zeroResults++;
    searchers.add(row.journeyId);
    if (!term) { last.delete(key); continue; }
    const group = byTerm.get(term) ?? { searches: 0, searchers: new Set(), zeroResults: 0, reformulations: 0 };
    group.searches++;
    group.searchers.add(row.journeyId);
    if (zeroResult) group.zeroResults++;
    const previous = last.get(key);
    if (previous && previous.term !== term && +row.at - previous.at <= 5 * 60_000 &&
        (previous.zeroResult || previous.term.split(/\s+/).some(word => word.length > 2 && term.split(/\s+/).includes(word)))) {
      reformulations++;
      const original = byTerm.get(previous.term);
      if (original) original.reformulations++;
    }
    byTerm.set(term, group);
    last.set(key, { term, at: +row.at, zeroResult });
  }
  return { searches, searchers: searchers.size, zeroResults, filterChanges, reformulations,
    terms: [...byTerm].flatMap(([term, counts]) => counts.searchers.size >= 2
      ? [{ term, ...counts, searchers: counts.searchers.size }] : [])
      .sort((a, b) => b.zeroResults - a.zeroResults || b.searchers - a.searchers || a.term.localeCompare(b.term)).slice(0, 75) };
}

type DayStatus = Pick<DemandDay, "availability" | "promotion">;

function observedDay(sample?: InventorySnapshot): DayStatus {
  const inStock = sample?.atLeastOneInStock;
  const outOfStock = sample?.atLeastOneStockout;
  return {
    availability: inStock && outOfStock ? "partial" : !sample?.stockCoverage ? "unknown" : inStock ? "available" : "stockout",
    promotion: sample?.promoted ? "active" : sample?.priceCoverage ? "none" : "unknown",
  };
}

export function observationCalendar(samples: InventorySnapshot[], variantIds: readonly string[]) {
  const byDay = new Map<string, Map<string, InventorySnapshot>>();
  for (const entry of samples) {
    const byVariant = byDay.get(entry.day) ?? new Map();
    byVariant.set(entry.variantId, entry);
    byDay.set(entry.day, byVariant);
  }
  return new Map([...byDay].map(([day, byVariant]): [string, DayStatus] => {
    const states = variantIds.map(id => observedDay(byVariant.get(id)));
    const kinds = new Set(states.map(state => state.availability));
    const availability = kinds.has("partial") || kinds.has("available") && kinds.has("stockout") ? "partial"
      : kinds.has("unknown") || !states.length ? "unknown" : kinds.has("available") ? "available" : "stockout";
    return [day, { availability, promotion: states.some(state => state.promotion === "active") ? "active"
      : states.length && states.every(state => state.promotion === "none") ? "none" : "unknown" }];
  }));
}
