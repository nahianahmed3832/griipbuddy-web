import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { answerProductIntelligence } from "../../src/lib/intelligence/analyst.ts";
import type { OpportunityAssessment } from "../../src/lib/intelligence/opportunities.ts";
import { productIntelligence } from "../../src/lib/intelligence/dataset.ts";
import { loadDemandHistory } from "../../src/lib/intelligence/history.ts";
import { localMarketTime } from "../../src/lib/market-calendar.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("market and variant evidence reconcile while bot, test and stockout classifications stay separate", async () => {
  const marker = randomUUID();
  const productId = `p-intelligence-${marker}`;
  const variantId = `v-intelligence-${marker}`;
  const bdOnlyId = `v-intelligence-bd-only-${marker}`;
  const attemptId = randomUUID(), orderId = randomUUID(), itemId = randomUUID(), returnId = randomUUID();
  const [shopper, other, automation, unclassified] = Array.from({ length: 4 }, () => randomUUID());
  const journeyIds = [shopper, other, automation, unclassified];
  const session = randomUUID();
  const now = new Date("2026-11-18T18:00:00Z");
  const near = (hour: string) => new Date(`2026-11-14T${hour}:00.000Z`);
  const observed = (journeyId: string, kind: "PRODUCT_IMPRESSION" | "PRODUCT_VIEW" | "CART_ADD" | "CHECKOUT_START" | "SEARCH", minute: number,
    details?: { query: string; resultCount: number }) => ({ id: randomUUID(), journeyId, sessionId: journeyId === shopper ? session : randomUUID(),
    kind, marketId: "bd" as const, at: near(`07:${String(minute).padStart(2, "0")}`), receivedAt: near(`07:${String(minute).padStart(2, "0")}`),
    ...(kind === "SEARCH" ? { details } : kind === "CHECKOUT_START" ? {} : { productId, variantId, placement: "search-results" }),
  });

  try {
    const department = await db.department.findFirstOrThrow({ select: { id: true } });
    await db.product.create({ data: { id: productId, slug: productId, departmentId: department.id, name: "Intelligence fixture", description: "Fixture",
      specifications: {}, keywords: [], addedOn: near("06:00"), position: 80, active: true, publication: "ACTIVE", demo: false,
      variants: { create: { id: variantId, sku: variantId, options: {}, label: "Fixture choice", position: 1, inventory: { create: { available: 9 } },
        offers: { create: [{ marketId: "bd", currency: "BDT", amountMinor: 12500 }, { marketId: "us", currency: "USD", amountMinor: 450 }] } } } } });
    await db.variant.create({ data: { id: bdOnlyId, productId, sku: bdOnlyId, options: {}, label: "Bangladesh-only choice", position: 2,
      offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 12500 } } } });
    await db.measurementJourney.createMany({ data: journeyIds.map(id => ({ id, test: id !== unclassified, automated: id === automation,
      grantedAt: near("06:00"), expiresAt: now })) });
    const term = `water resistant travel bottle ${marker.slice(0, 4).replace(/[0-9]/g, "z")}`;
    await db.measurementEvent.createMany({ data: [
      observed(shopper, "SEARCH", 1, { query: term, resultCount: 0 }),
      observed(shopper, "SEARCH", 2, { query: `${term} steel`, resultCount: 2 }),
      observed(other, "SEARCH", 2, { query: term, resultCount: 0 }),
      observed(shopper, "PRODUCT_IMPRESSION", 3), observed(shopper, "PRODUCT_VIEW", 4), observed(shopper, "PRODUCT_VIEW", 5),
      observed(shopper, "CART_ADD", 6), observed(shopper, "CHECKOUT_START", 7),
      observed(automation, "PRODUCT_VIEW", 8), observed(unclassified, "PRODUCT_VIEW", 9),
      { ...observed(shopper, "PRODUCT_VIEW", 9), marketId: "us", variantId: bdOnlyId },
    ] });
    await db.checkoutAttempt.create({ data: { id: attemptId, marketId: "bd", commerceEvidence: "fixture", paymentMethod: "COD",
      guestKey: marker, requestHash: marker, createdAt: near("07:00") } });
    await db.order.create({ data: { id: orderId, attemptId, reference: `INT-QA-${marker}`, marketId: "bd", currency: "BDT",
      status: "PLACED", fulfillmentStatus: "DELIVERED", customerName: "Synthetic fixture", phone: "00000000", district: "dhaka", districtLabel: "Dhaka",
      locality: "Fixture", address: "Fixture", deliveryMethod: "fixture", deliveryLabel: "Fixture", taxLabel: "Fixture",
      subtotalMinor: 25000, discountMinor: 2000, deliveryMinor: 500, taxMinor: 0, totalMinor: 23500,
      createdAt: near("08:00"), updatedAt: near("12:00"), measurementTest: true, commerceEvidence: "fixture",
      measurement: { create: { journeyId: shopper, sessionId: session } } } });
    await db.orderItem.create({ data: { id: itemId, orderId, variantId, productName: "Intelligence fixture", sku: variantId, variantName: "Fixture choice",
      quantity: 2, unitPriceMinor: 12500, unitDiscountMinor: 1000, lineTotalMinor: 23000, currency: "BDT" } });
    await db.payment.create({ data: { orderId, method: "COD", status: "COLLECTED", amountMinor: 23500, currency: "BDT", collectedAt: near("11:00") } });
    await db.codRemittance.create({ data: { orderId, attempt: 1, status: "MATCHED", reference: "Isolated QA fixture", expectedGrossMinor: 23500,
      grossMinor: 23500, deductionsMinor: 500, netMinor: 23000, createdAt: near("12:00") } });
    await db.fulfillmentEvent.create({ data: { orderId, type: "STATUS_CHANGED", status: "DELIVERED", createdAt: near("11:00") } });
    await db.orderCase.create({ data: { id: returnId, orderId, kind: "RETURN", status: "RETURN_RECEIVED", createdAt: near("12:00"),
      returnReceivedAt: new Date("2026-11-15T02:00:00Z"), returnDisposition: "HOLD", returnLines: { create: { orderItemId: itemId, quantity: 1 } } } });
    for (const [day, available] of [["2026-11-13", 0], ["2026-11-14", 9]] as const) {
      for (const time of ["01:05", "07:05", "13:05", "19:05"]) {
        const at = localMarketTime(`${day}T${time}`, "Asia/Dhaka")!;
        await db.productIntelligenceSnapshot.create({ data: { marketId: "bd", test: true, variantId, observedAt: at,
          slot: new Date(Math.floor(+at / 3_600_000) * 3_600_000), currency: "BDT", priceMinor: 12500,
          discountMinor: available ? 1000 : 0, available, deliveryAvailable: true, source: "isolated-test" } });
      }
    }

    const scope = { marketId: "bd" as const, test: true, productId, variantId, now, from: "2026-11-13", to: "2026-11-16" };
    const report = await productIntelligence(scope);
    assert.equal(report.kind, "report");
    const row = report.products.find(entry => entry.variantId === variantId)!;
    assert.equal(row.currency, "BDT");
    assert.equal(row.metrics.viewers, 1);
    assert.equal(row.metrics.impressions, 1);
    assert.equal(row.metrics.viewedThenCart, 1);
    assert.equal(row.metrics.viewedThenCheckout, 1);
    assert.equal(row.metrics.viewedThenPaid, 1);
    assert.equal(row.metrics.bookedOrders, 1);
    assert.equal(row.metrics.paidUnits, 2);
    assert.equal(row.metrics.deliveredOrders, 1);
    assert.equal(row.metrics.codRemittedOrders, 1);
    assert.equal(row.metrics.returnedUnits, 1);
    assert.equal(row.availability.stockoutDays, 1);
    assert.equal(row.availability.promotionDays, 1);
    assert.equal(row.availability.unknownDays, 2);
    assert.equal(row.finance.bookedMerchandiseMinor, 23_000n);
    assert.equal(row.finance.collectedMinor, 23_500n);
    assert.equal(row.finance.remittedMinor, 23_000n);
    assert.equal(row.finance.contributionMinor, null);
    assert.deepEqual(report.searches.terms.find(entry => entry.term === term), { term, searches: 2, searchers: 2, zeroResults: 2, reformulations: 1 });

    const history = await loadDemandHistory(scope);
    assert.equal(history.kind, "history");
    assert.deepEqual(history.observations.map(d => [d.day, d.bookedUnits, d.returnedUnits, d.availability]), [
      ["2026-11-13", 0, 0, "stockout"], ["2026-11-14", 2, 0, "available"],
      ["2026-11-15", 0, 1, "unknown"], ["2026-11-16", 0, 0, "unknown"],
    ]);
    const us = await productIntelligence({ ...scope, marketId: "us" });
    assert.equal(us.kind, "report");
    assert.equal(us.currency, "USD");
    assert.equal(us.products.find(entry => entry.variantId === variantId)?.metrics.bookedUnits, 0);
    const oldBrowserEvent = await productIntelligence({ ...scope, marketId: "us", variantId: bdOnlyId });
    assert.equal(oldBrowserEvent.kind, "report");
    assert.equal(oldBrowserEvent.products.length, 0);
    assert.equal(oldBrowserEvent.market.viewers, 0);
    const live = await productIntelligence({ ...scope, test: false });
    assert.equal(live.kind, "report");
    assert.equal(live.products.find(entry => entry.variantId === variantId)?.metrics.bookedOrders, 0);
  } finally {
    await db.productIntelligenceSnapshot.deleteMany({ where: { variantId } });
    await db.measurementJourney.deleteMany({ where: { id: { in: journeyIds } } });
    await db.orderCase.deleteMany({ where: { id: returnId } });
    await db.fulfillmentEvent.deleteMany({ where: { orderId } });
    await db.codRemittance.deleteMany({ where: { orderId } });
    await db.payment.deleteMany({ where: { orderId } });
    await db.orderItem.deleteMany({ where: { id: itemId } });
    await db.order.deleteMany({ where: { id: orderId } });
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
    await db.inventory.deleteMany({ where: { variantId } });
    await db.marketOffer.deleteMany({ where: { variantId: { in: [variantId, bdOnlyId] } } });
    await db.variant.deleteMany({ where: { id: { in: [variantId, bdOnlyId] } } });
    await db.product.deleteMany({ where: { id: productId } });
  }
});

test("concurrent explanations share the provider budget and send aggregate evidence only", async t => {
  const key = randomUUID() + randomUUID();
  const quota = createHmac("sha256", key).update("intelligence.analyst.provider:\0storefront").digest("hex");
  const environment = { CHECKOUT_SECRET: key, PRODUCT_INTELLIGENCE_ANALYST_PROVIDER: "openai",
    PRODUCT_INTELLIGENCE_ANALYST_MODEL: "fixture-model", PRODUCT_INTELLIGENCE_ANALYST_API_KEY: "fixture-key",
    PRODUCT_INTELLIGENCE_ANALYST_MAX_CALLS_PER_24H: "1" };
  const prior = Object.keys(environment).map(name => [name, process.env[name]] as const);
  const assessment: OpportunityAssessment = { id: "fixture-id", kind: "unmet-search", signal: "interest", title: "Synthetic title",
    marketId: "bd", term: "Synthetic confidential term", facts: ["Fixture evidence"], hypothesis: "Inspect eligible inventory.",
    limitations: [], sample: 8, confidence: "directional", action: "investigate", href: "/staff/intelligence" };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, request: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(request.body));
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 300);
    assert.deepEqual(JSON.parse(body.input), { market: "bd", window: { from: "2026-11-18", to: "2026-11-18" }, test: true,
      intent: "search", evidence: [{ kind: "unmet-search", signal: "interest", confidence: "directional", sample: 8 }] });
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      explanation: "Investigate whether local catalog availability explains the search gap.", evidenceIndex: 0,
    }) }] }] });
  });
  try {
    Object.assign(process.env, environment);
    const report = await productIntelligence({ marketId: "bd", test: true, from: "2026-11-18", to: "2026-11-18",
      now: new Date("2026-11-20T12:00:00Z") });
    assert.equal(report.kind, "report");
    const answers = await Promise.all([1, 2].map(() => answerProductIntelligence({ report, assessments: [assessment],
      question: "What search gap needs review?" })));
    assert.deepEqual(answers.map(answer => answer.connection).sort(), ["configured", "limited"]);
    assert.deepEqual(answers.map(answer => answer.explanationSource).sort(), ["evidence", "llm"]);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await db.requestQuota.deleteMany({ where: { key: quota } });
  }
});
