import assert from "node:assert/strict";
import test from "node:test";
import { marketDay, localMarketTime } from "../src/lib/market-calendar.ts";
import { cohortWindow } from "../src/lib/measurement/domain.ts";
import { configuredReportingFx, convertedTotal, reportingFx } from "../src/lib/measurement/reporting-fx.ts";
import { summarizeForecast } from "../src/lib/measurement/forecast.ts";
import { contributionProfit } from "../src/lib/measurement/contribution.ts";

test("the same UTC instant follows each market's calendar including DST", () => {
  const now = new Date("2026-11-02T03:00:00Z");
  assert.equal(marketDay(now, "Asia/Dhaka"), "2026-11-02");
  assert.equal(marketDay(now, "America/New_York"), "2026-11-01");
  const end = new Date("2026-11-03T09:00:00Z");
  const us = cohortWindow(end, "2026-11-01", "2026-11-01", "America/New_York");
  const bd = cohortWindow(end, "2026-11-01", "2026-11-01", "Asia/Dhaka");
  assert.equal(+us.until - +us.fromAt, 25 * 3_600_000);
  assert.equal(+bd.until - +bd.fromAt, 24 * 3_600_000);
  assert.equal(localMarketTime("2026-11-01T01:30", "America/New_York"), null);
  assert.equal(localMarketTime("2026-11-01T01:30", "Asia/Dhaka")?.toISOString(), "2026-10-31T19:30:00.000Z");
});

test("FX consolidation requires compatible dated evidence and uses integer rounding", () => {
  const input = JSON.stringify({ asOf: "2026-11-18", currency: "USD", source: "Test fixture", rates: { BDT: "0.0081" } });
  assert.equal(reportingFx(input, "2026-11-17"), null);
  const fx = reportingFx(input, "2026-11-18")!;
  assert.equal(convertedTotal([{ currency: "BDT", amount: 500_000n }, { currency: "USD", amount: 500n }], fx), 4550n);
  assert.equal(convertedTotal([{ currency: "BDT", amount: 1_000_000n }], { ...fx, rates: {} }), null);
  assert.equal(convertedTotal([{ currency: "BDT", amount: null }], fx), null);
  const half = { ...fx, rates: { BDT: "0.5" } };
  assert.equal(convertedTotal([{ currency: "BDT", amount: -1n }], half), -1n);
});

test("test reporting rates cannot appear in live reports", () => {
  const live = process.env.GRIIP_REPORTING_FX;
  const fixture = process.env.GRIIP_REPORTING_FX_TEST;
  try {
    delete process.env.GRIIP_REPORTING_FX;
    const date = "2026-11-18";
    const sheet = { asOf: date, currency: "USD", rates: { BDT: "0.01" } };
    process.env.GRIIP_REPORTING_FX_TEST = JSON.stringify({ ...sheet, source: "Synthetic fixture" });
    assert.equal(configuredReportingFx(date, false), null);
    assert.equal(configuredReportingFx(date, true)?.source, "Synthetic fixture");
    assert.equal(configuredReportingFx("2026-11-19", true), null);
    process.env.GRIIP_REPORTING_FX = JSON.stringify({ ...sheet, source: "Approved sheet" });
    assert.equal(configuredReportingFx(date, false)?.source, "Approved sheet");
  } finally {
    if (live === undefined) delete process.env.GRIIP_REPORTING_FX;
    else process.env.GRIIP_REPORTING_FX = live;
    if (fixture === undefined) delete process.env.GRIIP_REPORTING_FX_TEST;
    else process.env.GRIIP_REPORTING_FX_TEST = fixture;
  }
});

test("contribution needs complete matching-currency costs through the last order update", () => {
  const verifiedThrough = new Date("2026-11-18T15:00:00Z");
  const source = { currency: "USD", verifiedThrough, revenueBeforeRefundsMinor: 8_000, refundsMinor: 500, itemCostMinor: 2_000,
    packagingMinor: 50, outboundMinor: 500, returnMinor: 0, paymentFeesMinor: 500 };
  const order = { currency: "USD", updatedAt: verifiedThrough, contributionEvidence: source };
  assert.equal(contributionProfit([order]).total, 4450n);
  const incomplete = { ...order, contributionEvidence: { ...source, returnMinor: null } };
  const result = contributionProfit([order, incomplete]);
  assert.equal(result.total, null);
  assert.deepEqual(result.missing, [["Return fulfillment", 1]]);
  assert.equal(contributionProfit([{ ...order, currency: "BDT" }]).total, null);
  assert.equal(contributionProfit([{ ...order, updatedAt: new Date(+verifiedThrough + 1) }]).total, null);
  assert.equal(contributionProfit([{ ...order, outcomes: [{ at: new Date(+verifiedThrough + 1) }] }]).total, null);
});

test("forecasting uses local market history and reports holdout error", () => {
  assert.equal(summarizeForecast([1, 2, 0, 3]).forecast, null);
  const result = summarizeForecast([5, 8, 7, 12]);
  assert.deepEqual(result.forecast, { estimate: 8, observedLow: 5, observedHigh: 12, lastWeekError: 5.3 });
});
