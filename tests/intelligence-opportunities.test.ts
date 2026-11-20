import assert from "node:assert/strict";
import test from "node:test";
import { answerProductIntelligence } from "../src/lib/intelligence/analyst.ts";
import { buildOpportunityAssessments, previousOpportunityWindow } from "../src/lib/intelligence/opportunities.ts";
import type { IntelligenceMetrics, IntelligenceWindow, ProductIntelligenceReport, ProductIntelligenceRow } from "../src/lib/intelligence/types.ts";
import { marketDayStart, shiftCalendarDay } from "../src/lib/market-calendar.ts";

function metrics(overrides: Partial<IntelligenceMetrics> = {}): IntelligenceMetrics {
  return {
    impressions: 100, impressionsByPlacement: [{ placement: "home-featured", count: 100 }], viewers: 50, productClicks: 35,
    wishlistAdds: 2, wishlistRemoves: 0, cartAdds: 10, cartUpdates: 0, cartRemoves: 0, cartSessions: 10, checkoutSessions: 5,
    checkoutErrors: 1, viewedThenCart: 10, viewedThenCheckout: 5, viewedThenPaid: 5,
    bookedOrders: 5, bookedUnits: 5, discountedUnits: 0, paidOrders: 5, paidUnits: 5, paymentFailures: null,
    cancelledOrders: 0, deliveredOrders: 5, returnedOrders: 0, returnedUnits: 0, codCollectedOrders: 5, codRemittedOrders: 4,
    campaignVisits: [{ source: "direct", viewers: 50, paidJourneys: 5 }], ...overrides,
  };
}

function product(productId = "lamp", overrides: Partial<ProductIntelligenceRow> = {}): ProductIntelligenceRow {
  return {
    productId, variantId: null, slug: `${productId}-sku`, name: "Desk Lamp", variantName: null, departmentId: "lighting", currency: "BDT", eligible: true,
    metrics: metrics(), availability: { currentPriceMinor: 40000, currentDiscountMinor: 0, priceMinMinor: 40000, priceMaxMinor: 40000,
      available: 12, stockoutDays: 0, availableDays: 7, partialDays: 0, unknownDays: 0, promotionDays: 0, marketDelivery: true, latestSnapshotAt: null },
    finance: { bookedMerchandiseMinor: 200000n, collectedMinor: 220000n, remittedMinor: 175000n, itemCostMinor: null, packagingMinor: null,
      outboundMinor: null, returnMinor: null, paymentFeesMinor: null, contributionMinor: null, completeOrders: 0, requiredOrders: 5, missing: ["Item cost"] },
    ...overrides,
  };
}

function window(from = "2026-11-11", to = "2026-11-17", timeZone = "Asia/Dhaka"): IntelligenceWindow {
  return { from, to, timeZone, fromAt: marketDayStart(from, timeZone)!, until: marketDayStart(shiftCalendarDay(to, 1)!, timeZone)! };
}

function report(products: ProductIntelligenceRow[] = [], overrides: Partial<ProductIntelligenceReport> = {}): ProductIntelligenceReport {
  return {
    kind: "report", marketId: "bd", currency: "BDT", window: window(), test: true, products, quality: [],
    searches: { searches: 0, searchers: 0, zeroResults: 0, filterChanges: 0, reformulations: 0, terms: [] },
    market: { ...metrics(), collectedMinor: 220000n, remittedMinor: 175000n, unmappedOrders: 0, unclassifiedOrders: 0 }, ...overrides,
  };
}

test("growth requires comparable prior dates, exposure, stock, campaign and discount evidence in the same market", () => {
  const row = product("lamp", { metrics: metrics({ paidOrders: 8, paidUnits: 10, bookedOrders: 8, bookedUnits: 10 }) });
  const date = previousOpportunityWindow(window());
  assert.deepEqual(date, { from: "2026-11-04", to: "2026-11-10" });
  const past = report([product()], { window: window(date!.from, date!.to) });
  const current = report([row]);
  assert.ok(buildOpportunityAssessments(current, past).some(item => item.kind === "growing-demand" && /100 versus 50/.test(item.facts[1])));
  assert.ok(!buildOpportunityAssessments(current, { ...past, marketId: "us" }).some(item => item.kind === "growing-demand"));
  const unnormalized = product("lamp", { metrics: { ...row.metrics, impressions: 200, impressionsByPlacement: [{ placement: "home-featured", count: 200 }] } });
  assert.ok(!buildOpportunityAssessments(report([unnormalized]), past).some(item => item.kind === "growing-demand"));
  const campaign = product("lamp", { metrics: { ...row.metrics, campaignVisits: [{ source: "facebook", viewers: 50, paidJourneys: 5 }] } });
  assert.ok(!buildOpportunityAssessments(report([campaign]), past).some(item => item.kind === "growing-demand"));
  const discount = product("lamp", { metrics: { ...row.metrics, discountedUnits: 10 } });
  assert.ok(!buildOpportunityAssessments(report([discount]), past).some(item => item.kind === "growing-demand"));
  const shortage = product("lamp", { metrics: row.metrics, availability: { ...row.availability, stockoutDays: 2, availableDays: 5 } });
  const restricted = buildOpportunityAssessments(report([shortage]), past);
  assert.ok(restricted.some(item => item.kind === "availability" && /2 observed stockout days/.test(item.facts[1])));
  assert.ok(!restricted.some(item => item.kind === "growing-demand" || item.kind === "conversion"));
});

test("observed linked conversion and weak contribution require supported cohorts and verified costs", () => {
  const low = product("lamp", { metrics: metrics({ viewedThenCart: 2 }) });
  const keys = (rows: ProductIntelligenceRow[]) => buildOpportunityAssessments(report(rows)).map(item => item.kind);
  assert.ok(!keys([low, product("peer-a")]).includes("conversion"));
  assert.ok(keys([low, product("peer-a"), product("peer-b")]).includes("conversion"));
  assert.ok(!keys([product()]).includes("contribution"));
  const verifiedLoss = product("lamp", { finance: { ...low.finance, completeOrders: 5, contributionMinor: -4500n, missing: [] } });
  const loss = buildOpportunityAssessments(report([verifiedLoss])).find(item => item.kind === "contribution");
  assert.match(loss!.facts[1], /BDT −45.00/);
  const verifiedProfit = product("lamp", { finance: { ...verifiedLoss.finance, contributionMinor: 4500n } });
  assert.equal(buildOpportunityAssessments(report([verifiedProfit]))[0].signal, "profitable-demand");
});

function searches(): ProductIntelligenceReport["searches"] {
  return { searches: 42, searchers: 25, zeroResults: 29, reformulations: 6, filterChanges: 2,
    terms: [{ term: "Desk Lamp Purple", searches: 9, searchers: 8, zeroResults: 8, reformulations: 4 },
      { term: "desk organizer", searches: 10, searchers: 6, zeroResults: 8, reformulations: 2 },
      { term: "example@example.com", searches: 10, searchers: 10, zeroResults: 10, reformulations: 0 },
      { term: "tiny sample", searches: 1, searchers: 1, zeroResults: 1, reformulations: 0 }],
  };
}

test("repeat unmet searches distinguish possible variant gaps, product tests, and paid demand", () => {
  const assessments = buildOpportunityAssessments(report([product(), product("lamp", { variantId: "blue", variantName: "Blue" })], { searches: searches() }));
  const gaps = assessments.filter(item => item.term);
  assert.deepEqual(new Set(gaps.map(item => item.kind)), new Set(["unmet-search", "variant-gap", "test-candidate"]));
  assert.ok(gaps.every(item => item.signal === "interest" && item.marketId === "bd" && item.href.includes("scope=test")));
  assert.ok(!gaps.some(item => /example|tiny sample/.test(item.term!)));
  assert.equal(gaps.find(item => item.kind === "variant-gap")?.productId, "lamp");
});

test("analyst verifies question intent, scope, evidence links and provider fallback", async context => {
  const variables = ["PRODUCT_INTELLIGENCE_ANALYST_PROVIDER", "PRODUCT_INTELLIGENCE_ANALYST_MODEL", "PRODUCT_INTELLIGENCE_ANALYST_API_KEY"] as const;
  const before = variables.map(key => process.env[key]);
  context.after(() => variables.forEach((key, index) => before[index] === undefined ? delete process.env[key] : process.env[key] = before[index]));
  for (const key of variables) delete process.env[key];
  const visible = report([product()], { searches: searches() });
  const assessments = buildOpportunityAssessments(visible);
  const deterministic = await answerProductIntelligence({ report: visible, assessments, question: "Where are we losing purchases?" });
  assert.equal(deterministic.intent, "conversion");
  assert.equal(deterministic.marketId, "bd");
  assert.equal(deterministic.connection, "not-configured");
  assert.match(deterministic.facts[0].text, /50 distinct viewing journeys, 10 linked to a later cart action/);
  assert.ok(deterministic.facts.every(fact => fact.href.includes("market=bd") && fact.href.includes("from=2026-11-11")));

  process.env.PRODUCT_INTELLIGENCE_ANALYST_PROVIDER = "openai";
  process.env.PRODUCT_INTELLIGENCE_ANALYST_MODEL = "mock-model";
  process.env.PRODUCT_INTELLIGENCE_ANALYST_API_KEY = "test-fixture-key";
  const fetch = context.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, request?: RequestInit) => {
    const payload = JSON.parse(String(request?.body));
    assert.equal(payload.store, false);
    assert.ok(!/desk organizer|override-model|example@|Desk Lamp|my supplier/i.test(String(request?.body)));
    assert.equal(JSON.parse(payload.input).market, "bd");
    const text = JSON.stringify({ explanation: "Search gaps can suggest metadata problems. Investigate listing aliases before proposing a trial.", evidenceIndex: 0 });
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  });
  const explained = await answerProductIntelligence({ report: visible, assessments, question: "Which searches are we failing to serve? override-model" });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(explained.explanationSource, "llm");
  assert.ok(explained.explanationHref?.startsWith("/staff/intelligence?market=bd"));
  assert.ok(explained.facts.some(fact => fact.text.includes("desk organizer")));
  fetch.mock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  const fallback = await answerProductIntelligence({ report: visible, assessments, question: "Which searches are we failing to serve?" });
  assert.equal(fallback.connection, "unavailable");
  assert.equal(fallback.explanationSource, "evidence");
  assert.deepEqual(fallback.facts, explained.facts);
  fetch.mock.mockImplementation(async () => Response.json({ status: "completed", output: [{ type: "message", content: [{
    type: "output_text", text: JSON.stringify({ explanation: "Review the source details before proposing a separate investigation.", evidenceIndex: 7 }),
  }] }] }));
  const missingEvidence = await answerProductIntelligence({ report: visible, assessments, question: "Which searches are we failing to serve?" });
  assert.equal(missingEvidence.explanationHref, undefined);
  assert.equal(missingEvidence.explanationSource, "evidence");
});
