import assert from "node:assert/strict";
import { test } from "node:test";
import { marketBehavior, marketCommerce } from "../src/lib/measurement/market-summary.ts";
import type { CommerceOutcome } from "../src/lib/measurement/outcomes.ts";
import { browserMeasurementSchema } from "../src/lib/measurement/schema.ts";

test("category measurement accepts scoped cards and only allowlisted filter controls", () => {
  const base = {
    version: 1, nonce: "bb968c0a-8b60-402a-836c-3b6f29f8ef67", sessionId: "b36b7d58-6210-4d04-bd70-17bdb5c27fd1",
    at: "2026-11-19T12:00:00Z", marketId: "us", categoryId: "protective-cases",
  };
  const card = {
    ...base, action: "PRODUCT_CLICK", placement: "category-grid",
    productId: "protective-case", variantId: "v-case-blue", currency: "USD", displayedPriceMinor: 2399,
  };
  const filter = {
    ...base, action: "CATEGORY_FILTER", placement: "category-listing", resultCount: 0,
    categoryFilters: { fields: ["model", "color"], sort: "price-low" },
  };
  const accepted = (input: unknown) => browserMeasurementSchema.safeParse(input).success;
  assert.ok(accepted(card));
  assert.ok(accepted({ ...card, variantId: undefined }));
  assert.ok(accepted(filter));
  assert.ok(accepted({ ...filter, categoryFilters: { fields: [] } }));
  assert.ok(!accepted({ ...card, categoryId: undefined }));
  assert.ok(!accepted({ ...card, currency: "BDT" }));
  assert.ok(!accepted({ ...card, placement: "shop" }));
  assert.ok(!accepted({ ...filter, productId: card.productId }));
  assert.ok(!accepted({ ...filter, categoryFilters: { fields: ["model", "model"] } }));
  assert.ok(!accepted({ ...filter, categoryFilters: { fields: ["model"], values: ["A potentially private value"] } }));
  assert.ok(!accepted({ ...filter, filterKey: "A local UI signature" }));
});

const clock = (time: string) => new Date(`2026-11-${time}Z`);

test("connected purchase observations bind a stable offer to its variant and market", () => {
  const selection = {
    version: 1, nonce: "bb968c0a-8b60-402a-836c-3b6f29f8ef67", sessionId: "b36b7d58-6210-4d04-bd70-17bdb5c27fd1",
    at: "2026-11-19T12:00:00Z", marketId: "us", action: "VARIANT_SELECTION", placement: "product-detail",
    productId: "protective-case", variantId: "v-case-blue", offerId: "e69ab192-2db4-4abc-bcc7-c5f50a86d832",
    displayedPriceMinor: 2300, currency: "USD",
  };
  const valid = (event: unknown) => browserMeasurementSchema.safeParse(event).success;
  assert.ok(valid(selection));
  assert.ok(valid({ ...selection, action: "CHECKOUT_FAILURE", step: "SUBMIT", failureCode: "UNAVAILABLE" }));
  assert.ok(!valid({ ...selection, variantId: undefined }));
  assert.ok(!valid({ ...selection, currency: "BDT" }));
  assert.ok(!valid({ ...selection, action: "ORDER_ACCEPTED" }));
  assert.ok(!valid({ ...selection, customerName: "Private shipping data" }));
});

test("search submissions and suggestions record intent without transmitting free text or pretending to be results", () => {
  const intent = {
    version: 1, nonce: "bb968c0a-8b60-402a-836c-3b6f29f8ef67", sessionId: "b36b7d58-6210-4d04-bd70-17bdb5c27fd1",
    at: "2026-11-19T12:00:00Z", marketId: "bd", action: "SEARCH", searchStage: "submitted", placement: "search-box",
  };
  const valid = (event: unknown) => browserMeasurementSchema.safeParse(event).success;
  assert.ok(valid(intent));
  assert.ok(valid({ ...intent, searchStage: "model-suggestion", placement: "search-model-suggestion" }));
  assert.ok(!valid({ ...intent, resultCount: 0 }));
  assert.ok(!valid({ ...intent, query: "Customer details" }));
  assert.ok(valid({ ...intent, searchStage: undefined, placement: "search-results", resultCount: 0 }));
  assert.ok(valid({ ...intent, action: "PRODUCT_CLICK", searchStage: undefined, placement: "search-suggestion",
    productId: "protective-case", variantId: "v-case-blue", offerId: "e69ab192-2db4-4abc-bcc7-c5f50a86d832" }));
  assert.ok(!valid({ ...intent, action: "PRODUCT_CLICK", searchStage: undefined, placement: "shop",
    productId: "protective-case", variantId: "v-case-blue", offerId: "e69ab192-2db4-4abc-bcc7-c5f50a86d832" }));
});
const window = { fromAt: clock("18T00:00:00"), until: clock("19T00:00:00") };

function observation(kind: string, time: string, sessionId: string | null, productId: string | null = null, details?: object) {
  return { kind, at: clock(time), sessionId, journeyId: "consent", productId, details };
}

test("a qualified session converts only for ordered product and checkout activity linked to that session", () => {
  const result = marketBehavior([
    observation("PRODUCT_VIEW", "17T23:57:00", "earlier", "case"),
    observation("CART_ADD", "18T00:03:00", "earlier", "case"),
    observation("PRODUCT_IMPRESSION", "18T13:00:00", "passive", "case"),
    observation("PRODUCT_VIEW", "18T13:01:00", null, "case"),
    observation("CART_ADD", "18T13:02:00", "other", "bag"),
    observation("PRODUCT_VIEW", "18T13:03:00", "other", "bag"),
    observation("CART_ADD", "18T13:04:00", "other", "case"),
    observation("CHECKOUT_START", "18T13:05:00", "other"),
    observation("CHECKOUT_FAILURE", "18T13:06:00", "other"),
    observation("PRODUCT_VIEW", "18T23:57:00", "matched", "case"),
    observation("CART_ADD", "18T23:58:00", "matched", "case"),
    observation("CHECKOUT_START", "18T23:59:00", "matched"),
  ], [
    { createdAt: clock("18T13:01:00"), measurement: { journeyId: "consent", sessionId: "other" } },
    { createdAt: clock("18T13:07:00"), measurement: { journeyId: "another-cookie", sessionId: "other" } },
    { createdAt: clock("18T13:07:00"), measurement: { journeyId: "consent", sessionId: null } },
    { createdAt: clock("19T00:00:00"), measurement: { journeyId: "consent", sessionId: "matched" } },
    { createdAt: clock("19T00:01:00"), measurement: { journeyId: "consent", sessionId: "matched" } },
  ], window);

  assert.equal(result.qualified, 2);
  assert.equal(result.productViews, 2);
  assert.equal(result.productToCart, 1);
  assert.equal(result.checkoutStarts, 2);
  assert.equal(result.checkoutToOrder, 1);
  assert.equal(result.checkoutFailures, 1);
});

test("search totals include redacted queries and separate filter changes", () => {
  const result = marketBehavior([
    observation("SEARCH", "18T11:01:00", "a", null, { query: "case", resultCount: 12 }),
    observation("SEARCH_FILTER", "18T11:02:00", "a", null, { query: "case", resultCount: 0 }),
    observation("SEARCH", "18T11:03:00", "a", null, { query: "unknown case", resultCount: 0 }),
    observation("SEARCH", "18T12:04:00", "b", null, { resultCount: 0 }),
    observation("SEARCH", "19T00:00:00", "outside", null, { query: "case", resultCount: 4 }),
  ], [], window);

  assert.equal(result.qualified, 2);
  assert.equal(result.searches, 3);
  assert.equal(result.zeros, 2);
  assert.equal(result.filterChanges, 1);
  assert.deepEqual(result.terms, [
    ["unknown case", { searches: 1, zeros: 1, sessions: 1 }],
    ["case", { searches: 1, zeros: 0, sessions: 1 }],
  ]);
});

test("commerce totals count orders once and keep COD booking, collection and remittance distinct", () => {
  const event = (kind: CommerceOutcome["kind"], amountMinor: number | null, id = kind as string): CommerceOutcome => ({
    kind, amountMinor, id, at: window.fromAt, schemaVersion: 1, orderId: "order", transactionId: "transaction",
    journeyId: null, sessionId: null, marketId: "bd", currency: "BDT", test: true, paymentMethod: "COD",
  });
  const booked = { subtotalMinor: 1000, discountMinor: 150, deliveryMinor: 150 };
  const totals = marketCommerce([
    { ...booked, payment: { method: "COD", status: "AWAITING_COLLECTION" }, outcomes: [event("ORDER_ACCEPTED", 1000)] },
    { ...booked, payment: { method: "COD", status: "COLLECTED" }, outcomes: [
      event("ORDER_ACCEPTED", 1000), event("ORDER_DELIVERED", null), event("COD_COLLECTED", 1000),
      { ...event("COD_REMITTED", 960), deductionsMinor: 40 },
    ] },
    { ...booked, payment: { method: "COD", status: "VOIDED" }, outcomes: [
      event("ORDER_ACCEPTED", 1000), event("ORDER_REFUSED", null, "parcel-1"), event("ORDER_REFUSED", null, "parcel-2"),
      event("RETURN_RECEIVED", null, "return-1"), event("RETURN_RECEIVED", null, "return-2"),
    ] },
  ], null);

  assert.equal(totals.accepted, 3);
  assert.equal(totals.delivered, 1);
  assert.equal(totals.codOrders, 3);
  assert.equal(totals.codAwaiting, 1);
  assert.equal(totals.codCollected, 1);
  assert.equal(totals.deliveryRefused, 1);
  assert.equal(totals.returned, 1);
  assert.equal(totals.providerFailures, null);
  assert.deepEqual(totals.finance, { merchandiseBooked: 2550n, deliveryCharged: 450n, codCollected: 1000n,
    prepaidCaptured: 0n, remittanceOrders: 1, remittanceNet: 960n, remittanceDeductions: 40n,
    merchandiseCovered: 3, deliveryCovered: 3 });
});

test("bridge bookings with incomplete price breakdowns retain verified cash evidence", () => {
  const evidence = { id: "bridge-cash", at: window.fromAt, schemaVersion: 1, orderId: "bridge-order", transactionId: "txn",
    journeyId: null, sessionId: null, marketId: "bd", currency: "BDT", test: true, paymentMethod: "COD" } as const;
  const totals = marketCommerce([{ subtotalMinor: null, discountMinor: null, deliveryMinor: null,
    payment: { method: "COD", status: "COLLECTED" },
    outcomes: [{ ...evidence, kind: "ORDER_ACCEPTED", amountMinor: 1000, evidence: "fixture" },
      { ...evidence, kind: "COD_COLLECTED", amountMinor: 1000 }] }], null);
  assert.equal(totals.evidence.fixture, 1);
  assert.equal(totals.finance.merchandiseCovered, 0);
  assert.equal(totals.finance.deliveryCovered, 0);
  assert.equal(totals.finance.codCollected, 1000n);
  assert.equal(totals.contribution.total, null);
});
