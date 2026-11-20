import { z } from "zod";
import { marketIds, type MarketId } from "../../config/markets.ts";
import { stagingDatabase } from "../db/local.ts";
import { reportFailure } from "../db/observability.ts";
import { marketDay, shiftCalendarDay } from "../market-calendar.ts";
import { forecastDemand, summarizeForecastBacktests, type DemandForecast, type ForecastAnalogue } from "./forecast.ts";
import { loadDemandHistory } from "./history.ts";
import { purchasingPolicies, recommendInventory, type InventoryPosition, type InventoryRecommendation, type PurchasingPolicy } from "./inventory.ts";
import type { DemandHistory, ProductIntelligenceReport, ProductIntelligenceRow } from "./types.ts";
import { maxIntelligenceDays } from "./window.ts";

const boardLimit = 6;
const fixturePurchasing: Partial<Record<MarketId, { variantId: string; unitCostMinor: number; availableBudgetMinor: number }>> = {
  bd: { variantId: "v-lamp-cream", unitCostMinor: 95_000, availableBudgetMinor: 2_500_000 },
  us: { variantId: "v-speaker-charcoal", unitCostMinor: 1_350, availableBudgetMinor: 50_000 },
};
const id = z.string().trim().min(1).max(160);
const ratio = z.number().min(0.25).max(4);
const analogueInput = z.strictObject({
  marketId: z.enum(marketIds), productId: id, variantId: id, sourceVariantId: id,
  rationale: z.string().trim().min(12).max(220), unitsRatio: ratio, ratioRange: z.tuple([ratio, ratio]),
}).refine(row => row.variantId !== row.sourceVariantId && row.ratioRange[0] <= row.unitsRatio && row.unitsRatio <= row.ratioRange[1]);

function analogueInputs(configured: string | undefined) {
  if (configured && configured.length <= 200_000) {
    try {
      const parsed = z.array(analogueInput).max(100).safeParse(JSON.parse(configured));
      if (parsed.success && new Set(parsed.data.map(row => JSON.stringify([row.marketId, row.productId, row.variantId]))).size === parsed.data.length) return parsed.data;
    } catch { /* Unavailable analogue policy falls back to a cold start. */ }
  }
  return [];
}

function popularEvidence(left: ProductIntelligenceRow, right: ProductIntelligenceRow) {
  return Number(right.eligible) - Number(left.eligible) || right.metrics.bookedUnits - left.metrics.bookedUnits ||
    right.metrics.viewers - left.metrics.viewers || left.productId.localeCompare(right.productId) ||
    (left.variantId ?? "").localeCompare(right.variantId ?? "");
}

function representativeBoard(products: readonly ProductIntelligenceRow[], limit: number) {
  const groupLeaders = new Set<string>();
  const chosen = new Set<ProductIntelligenceRow>();
  for (const row of products) {
    if (groupLeaders.has(row.departmentId)) continue;
    groupLeaders.add(row.departmentId);
    chosen.add(row);
    if (chosen.size === limit) return [...chosen];
  }
  for (const row of products) {
    chosen.add(row);
    if (chosen.size === limit) break;
  }
  return [...chosen];
}

export type ForecastBoard = {
  entries: { row: ProductIntelligenceRow; forecast: DemandForecast; inventory: InventoryRecommendation | null }[];
  selectedProductId: string | null;
  selectedVariantId: string | null;
  evaluation: ReturnType<typeof summarizeForecastBacktests>;
  purchasingState: ReturnType<typeof purchasingPolicies>["state"] | "fixture";
  omitted: number;
  selectionUnavailable: boolean;
};

function fixturePurchasingPolicy(position: InventoryPosition, marketId: MarketId, currency: PurchasingPolicy["currency"], today: string): PurchasingPolicy | undefined {
  const fixture = fixturePurchasing[marketId];
  if (!fixture) return;
  const poolId = `review-dispatch-${marketId}:${fixture.variantId}`;
  if (position.kind !== "market" || position.variantId !== fixture.variantId || position.poolIds.length !== 1 || position.poolIds[0] !== poolId) return;
  return {
    ...fixture, poolId, markets: [marketId], currency, source: "Staging purchasing fixture", asOfDay: today,
    leadTimeDays: 4, reviewDays: 3, supplierOnTimeRate: 0.92, safetyStockUnits: 2, serviceTarget: 0.8,
    minimumOrderUnits: 4, unitsPerCase: 2, shelfLifeDays: null, reservedUnits: position.reserved ?? 0, incoming: [],
  };
}

export function reviewPurchasingPolicy(history: DemandHistory, variantId: string, today: string,
  configured = purchasingPolicies(process.env.GRIIP_INTELLIGENCE_PURCHASING)) {
  const { inventory, marketId, currency, test } = history;
  const position = { ...inventory, variantId };
  const allowFixture = test && process.env.GRIIP_MARKET_REVIEW_FIXTURES === "1" && stagingDatabase() && configured.state === "unavailable";
  return configured.policies.find(item => position.kind === "market" && item.variantId === variantId && inventory.poolIds.length === 1 &&
      item.poolId === inventory.poolIds[0] && item.markets.includes(marketId)) ??
    (allowFixture ? fixturePurchasingPolicy(position, marketId, currency, today) : undefined);
}

export async function loadForecastBoard(report: ProductIntelligenceReport, options: {
  productId?: string;
  variantId?: string;
  horizonDays: number;
  authorizedMarkets: readonly MarketId[];
  now?: Date;
}): Promise<ForecastBoard> {
  const { marketId, test, window, currency } = report;
  if (!options.authorizedMarkets.includes(marketId)) throw new Error("Forecast market permission required.");
  const now = options.now ?? new Date();
  const asOfDay = shiftCalendarDay(window.to, 1)!;
  const today = marketDay(now, window.timeZone);
  const purchasing = purchasingPolicies(process.env.GRIIP_INTELLIGENCE_PURCHASING);
  const showPurchasingFixture = test && process.env.GRIIP_MARKET_REVIEW_FIXTURES === "1" && stagingDatabase() && purchasing.state === "unavailable";
  const approvedAnalogues = analogueInputs(process.env.GRIIP_INTELLIGENCE_ANALOGUES);
  const products = report.products.filter(row => row.variantId === null).sort(popularEvidence);
  const eligibleVariants = report.products.filter(row => row.variantId !== null && row.eligible &&
    (row.metrics.bookedUnits > 0 || row.metrics.viewers > 0 || row.availability.stockoutDays > 0));
  const stockCandidates = eligibleVariants.sort((left, right) => {
    const priority = (row: ProductIntelligenceRow) => row.availability.available !== null && row.metrics.bookedUnits > 0
      ? row.availability.available / row.metrics.bookedUnits : Number.POSITIVE_INFINITY;
    return priority(left) - priority(right) || popularEvidence(left, right);
  });
  const stockExamples = representativeBoard(stockCandidates, 2);
  const parent = products.find(row => row.productId === options.productId);
  const variants = parent ? report.products.filter(row => row.productId === parent.productId && row.variantId !== null).sort(popularEvidence) : [];
  const variant = variants.find(row => row.variantId === options.variantId);
  const selectionUnavailable = Boolean(options.productId && !parent || options.variantId && !variant);
  let sourceSize = products.length + eligibleVariants.length;
  let rows = [...representativeBoard(products, boardLimit - stockExamples.length), ...stockExamples];
  if (parent) {
    sourceSize = variants.length + 1;
    rows = variant ? [parent, variant] : [parent, ...variants.slice(0, boardLimit - 1)];
  }
  if (selectionUnavailable) rows = [];
  const history = (row: Pick<ProductIntelligenceRow, "productId" | "variantId">) => loadDemandHistory({
    marketId, test, productId: row.productId, variantId: row.variantId ?? undefined,
    from: shiftCalendarDay(asOfDay, -maxIntelligenceDays)!, to: window.to, now,
  });
  const makeEntry = async (row: ProductIntelligenceRow) => {
    const identity = { marketId, productId: row.productId, variantId: row.variantId ?? undefined, group: row.departmentId };
    const forecastOptions = { identity, asOfDay, horizonDays: options.horizonDays };
    let data: Awaited<ReturnType<typeof history>> | null;
    try { data = await history(row); }
    catch (error) {
      reportFailure("intelligence.forecast-history", undefined, error);
      data = null;
    }
    if (!data || data.kind !== "history") {
      const forecast = forecastDemand([], forecastOptions);
      forecast.limitations.unshift("The history is unavailable for this reporting window.");
      return { row, forecast, inventory: null };
    }
    let forecast = forecastDemand(data.observations, forecastOptions);
    if (forecast.status === "insufficient" && row.variantId) {
      const spec = approvedAnalogues.find(analogue => analogue.marketId === marketId && analogue.productId === row.productId && analogue.variantId === row.variantId);
      const source = spec && variants.find(item => item.variantId === spec.sourceVariantId && item.eligible);
      if (spec && source) {
        try {
          const peer = await history(source);
          if (peer.kind === "history") {
            const analogue: ForecastAnalogue = { ...spec, comparable: "same-product-variant", forecast: forecastDemand(peer.observations,
              { ...forecastOptions, identity: { ...identity, variantId: source.variantId! } }) };
            forecast = forecastDemand(data.observations, { ...forecastOptions, analogues: [analogue] });
          }
        } catch (error) { reportFailure("intelligence.forecast-analogue", undefined, error); }
      }
    }
    if (!row.variantId || !row.eligible || today !== asOfDay) return { row, forecast, inventory: null };
    const position = { ...data.inventory, variantId: row.variantId };
    const policy = reviewPurchasingPolicy(data, row.variantId, today, purchasing);
    const planningForecast = policy ? forecastDemand(data.observations, {
      identity, asOfDay, horizonDays: policy.leadTimeDays + policy.reviewDays, coverage: policy.serviceTarget,
    }) : forecast;
    const inventory = recommendInventory({ position, marketId, marketCurrency: currency,
      deliveryAvailable: row.availability.marketDelivery, snapshotDay: today, forecasts: [planningForecast], policy });
    return { row, forecast, inventory };
  };
  const entries: ForecastBoard["entries"] = [];
  // Bounded parallelism prevents a staff overview from monopolizing the shared connection pool.
  for (let index = 0; index < rows.length; index += 3) entries.push(...await Promise.all(rows.slice(index, index + 3).map(makeEntry)));
  return {
    entries, selectedProductId: parent?.productId ?? null, selectedVariantId: variant?.variantId ?? null,
    evaluation: summarizeForecastBacktests(entries.map(entry => entry.forecast)), purchasingState: showPurchasingFixture ? "fixture" : purchasing.state,
    omitted: selectionUnavailable ? 0 : Math.max(0, sourceSize - entries.length), selectionUnavailable,
  };
}
