import assert from "node:assert/strict";
import { test } from "node:test";
import { shiftCalendarDay } from "../src/lib/market-calendar.ts";
import { forecastDemand, summarizeForecastBacktests, type DemandObservation, type ForecastIdentity } from "../src/lib/intelligence/forecast.ts";
import { purchasingPolicies, recommendInventory, type PurchasingPolicy } from "../src/lib/intelligence/inventory.ts";

const day = "2026-11-18";
const identity: ForecastIdentity = { marketId: "bd", productId: "fixture-product", variantId: "fixture-sku", group: "Home" };

const series = (value: (index: number) => number, days = 210): DemandObservation[] => Array.from({ length: days }, (_, index) => ({
  day: shiftCalendarDay(day, index - days)!, bookedUnits: value(index), availability: "available", promotion: "none",
}));
const steady = series(() => 2);

test("an ordinary-demand forecast discards future rows and stockout, promotion and coverage gaps", () => {
  const history = steady.filter((_, i) => i !== 31).map((row, i): DemandObservation => {
    if (i === 40) return { ...row, bookedUnits: 999, availability: "stockout" };
    if (i === 41) return { ...row, bookedUnits: 999, promotion: "active" };
    if (i === 42) return { ...row, bookedUnits: 999, availability: "partial", returnedUnits: 2 };
    if (i === 43) return { ...row, bookedUnits: 999, promotion: "unknown" };
    return row;
  });
  const options = { identity, asOfDay: day, horizonDays: 7 };
  const expected = forecastDemand(history, options);
  assert.deepEqual(forecastDemand([...history, { ...history[0], day, bookedUnits: 100_000 }], options), expected);
  assert.equal(expected.status, "ready");
  assert.equal(expected.pointUnits, 14);
  assert.deepEqual(expected.interval && [expected.interval.lowerUnits, expected.interval.upperUnits], [14, 14]);
  assert.equal(expected.evidence.stockoutDays, 1);
  assert.equal(expected.evidence.partialDays, 1);
  assert.equal(expected.evidence.promotedDays, 1);
  assert.equal(expected.evidence.unknownAvailabilityDays, 1);
  assert.equal(expected.evidence.observedReturnedUnits, 2);
  const score = expected.comparisons.find(row => row.model === "recent-mean")!;
  assert.ok(score.windows > 8);
  assert.equal(score.meanAbsoluteError, 0);
  assert.equal(score.meanSignedError, 0);
  assert.equal(score.intervalCoverage, 1);
});

test("rolling evidence detects weekday structure and compares intermittent baseline on zero-heavy days", () => {
  const weekday = forecastDemand(series(i => i % 7 === 0 ? 20 : 2), { identity, asOfDay: day, horizonDays: 1 });
  assert.equal(weekday.model, "weekly-naive");
  assert.equal(weekday.pointUnits, 20);
  const monthly = forecastDemand(series(i => i % 9 === 0 ? 8 : 0), { identity, asOfDay: day, horizonDays: 7 });
  assert.ok(monthly.comparisons.some(row => row.model === "croston-sba" && row.windows > 0 && row.wape !== null));
  const grouped = summarizeForecastBacktests([monthly, { ...monthly, identity: { ...identity, marketId: "us" } },
    { ...monthly, identity: { ...identity, variantId: undefined } }]);
  assert.ok(grouped.some(row => row.marketId === "bd" && row.level === "product" && row.evaluatedSeries === 1));
  assert.ok(grouped.some(row => row.marketId === "bd" && row.level === "variant" && row.evaluatedSeries === 1));
  assert.ok(grouped.some(row => row.marketId === "us" && row.level === "variant" && row.evaluatedSeries === 1));
});

test("cold starts require a bounded reviewed same-market analogue and disclose provenance", () => {
  const peer = forecastDemand(steady, { identity, asOfDay: day, horizonDays: 7 });
  const target = { ...identity, variantId: "new-variant" };
  const options = { identity: target, asOfDay: day, horizonDays: 7 };
  const analogue = { forecast: peer, comparable: "same-product-variant" as const, rationale: "Same style and pack size in a new neutral color.",
    unitsRatio: 0.75, ratioRange: [0.5, 1] as const };
  assert.equal(forecastDemand([], options).status, "insufficient");
  const foreign = { ...analogue, forecast: { ...peer, identity: { ...identity, marketId: "us" as const } } };
  assert.equal(forecastDemand([], { ...options, analogues: [foreign] }).status, "insufficient");
  const sourced = forecastDemand([], { ...options, analogues: [analogue] });
  assert.equal(sourced.status, "analogue");
  assert.equal(sourced.pointUnits, 10.5);
  assert.deepEqual(sourced.analogue?.scenarioRangeUnits, { lowerUnits: 7, upperUnits: 14 });
  assert.equal(sourced.analogue?.identity.variantId, "fixture-sku");
  assert.equal(sourced.interval, null);
});

const policy: PurchasingPolicy = {
  poolId: "primary", variantId: "fixture-sku", markets: ["bd"], currency: "BDT", source: "Dated fixture policy", asOfDay: day,
  leadTimeDays: 4, reviewDays: 3, supplierOnTimeRate: 0.9, serviceTarget: 0.8,
  safetyStockUnits: 4, minimumOrderUnits: 6, unitsPerCase: 6, shelfLifeDays: null, unitCostMinor: 1200,
  availableBudgetMinor: 20_000, reservedUnits: 8, incoming: [{ id: "shipment-a", units: 2, expectedOn: shiftCalendarDay(day, 2)! }],
};
const position = { variantId: "fixture-sku", kind: "market" as const, poolIds: ["primary"], available: 7, reserved: 8, incoming: 2 };
const stockForecast = forecastDemand(steady, { identity, asOfDay: day, horizonDays: 7 });
const input = { position, marketId: "bd" as const, marketCurrency: "BDT" as const, deliveryAvailable: true, snapshotDay: day, forecasts: [stockForecast] };

test("replenishment uses free inventory once, reconciles inbound, and applies case size and local costs", () => {
  const assessed = recommendInventory({ ...input, policy });
  assert.equal(assessed.action, "replenish");
  assert.equal(assessed.quantity, 12);
  assert.equal(assessed.estimatedCostMinor, 14_400);
  assert.equal(assessed.reserved, 8);
  assert.equal(assessed.currency, "BDT");
  assert.equal(recommendInventory(input).quantity, null);
  assert.equal(recommendInventory({ ...input, policy: { ...policy, availableBudgetMinor: 1_000 } }).quantity, null);
  assert.equal(recommendInventory({ ...input, policy: { ...policy, shelfLifeDays: 1 } }).quantity, null);
  assert.equal(recommendInventory({ ...input, policy: { ...policy, currency: "USD" } }).quantity, null);
  assert.equal(recommendInventory({ ...input, deliveryAvailable: false, policy }).quantity, null);
  assert.equal(recommendInventory({ ...input, position: { ...position, incoming: 3 }, policy }).quantity, null);
  assert.equal(purchasingPolicies(JSON.stringify([policy])).state, "ready");
  assert.equal(purchasingPolicies(JSON.stringify([policy, policy])).state, "invalid");
});

test("a shared stock pool can produce only one fully authorized consolidated proposal", () => {
  const both = ["bd", "us"] as const;
  const shared = { ...input, position: { ...position, kind: "shared" as const }, policy: { ...policy, markets: [...both], availableBudgetMinor: null },
    sharedConsumers: both, forecasts: [stockForecast, { ...stockForecast, identity: { ...identity, marketId: "us" as const } }] };
  assert.equal(recommendInventory(shared).quantity, null);
  assert.equal(recommendInventory({ ...shared, consolidatedReview: true, authorizedMarkets: ["bd"] }).quantity, null);
  const combined = { ...shared, consolidatedReview: true, authorizedMarkets: both };
  assert.equal(recommendInventory(combined).quantity, 24);
  assert.equal(recommendInventory({ ...combined, marketId: "us", marketCurrency: "USD" }).quantity, null);
  assert.equal(recommendInventory({ ...combined, forecasts: [...combined.forecasts, stockForecast] }).quantity, null);
});
