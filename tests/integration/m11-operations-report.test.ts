import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { loadOperationsReport, OperationsReportError, reportQuery } from "../../src/lib/staff/operations-report.ts";
import { operationsCsv } from "../../src/lib/staff/operations-report-table.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());
const origin = "http://127.0.0.1:46121";
const now = new Date("2027-01-03T10:00:00Z");
const date = (value: string) => new Date(value);
const jan = (market: "bd" | "us", view = "daily", filters = {}) => reportQuery({
  market, view, from: "2027-01-01", to: "2027-01-01", ...filters,
}, market, origin, now);
const unavailable = (error: unknown) => error instanceof OperationsReportError && error.status === 404;

async function staff(role: "OWNER" | "PACKER", reporting = true, operations = false) {
  const id = randomUUID();
  await db.user.create({ data: { id, name: "Synthetic report staff", email: id + "@example.invalid",
    staff: { create: { role, ...(role === "PACKER" && { marketGrants: { create: { marketId: "bd", reporting, operations } } }) } } } });
  return id;
}

test("report reconciles independent market, calendar, event, refund and scope fixtures", async t => {
  const owner = await staff("OWNER"), bdReporter = await staff("PACKER"), bdOperations = await staff("PACKER", true, true);
  const buyer = randomUUID(), seller = randomUUID();
  const ids: { order: string; attempt: string }[] = [];
  await db.shopper.create({ data: { id: buyer, name: "Excluded private buyer", email: buyer + "@example.invalid" } });
  await db.marketplaceShop.create({ data: { id: seller, name: "Fixture independent merchant", slug: seller, announcement: "", about: "" } });
  t.after(async () => {
    const orderIds = ids.map(item => item.order);
    await db.orderCase.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.codRemittance.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.fulfillmentEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.payPalCheckout.deleteMany({ where: { attemptId: { in: ids.map(item => item.attempt) } } });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: ids.map(item => item.attempt) } } });
    await db.marketplaceShop.delete({ where: { id: seller } });
    await db.shopper.delete({ where: { id: buyer } });
    await db.user.deleteMany({ where: { id: { in: [owner, bdReporter, bdOperations] } } });
  });

  async function order(input: { market: "bd" | "us"; at: string; minor: number; shopper?: string;
    evidence?: "production" | "fixture" | null; merchant?: string }) {
    const orderId = randomUUID(), attemptId = randomUUID(), currency = input.market === "bd" ? "BDT" : "USD";
    const method = input.market === "bd" ? "COD" : "PAYPAL";
    const evidence = input.evidence === undefined ? "fixture" : input.evidence;
    const createdAt = date(input.at);
    const tx = await db.order.create({ data: {
      id: orderId, reference: "=M11-" + orderId.substring(0, 12), createdAt,
      attempt: { create: { id: attemptId, guestKey: "z".repeat(64), requestHash: "a".repeat(64), marketId: input.market,
        paymentMethod: method, commerceEvidence: evidence,
        ...(method === "PAYPAL" && { paypal: { create: { expiresAt: now, state: "COMPLETED", captureId: "TEST-" + attemptId,
          expectedAmountMinor: input.minor } } }),
      } },
      marketId: input.market, currency, ...(input.shopper && { shopper: { connect: { id: input.shopper } } }), customerName: "Excluded private buyer", phone: "00000000000",
      email: "private@example.invalid", address: "Never exported address", locality: "Fixture",
      district: "fixture", districtLabel: "Fixture district", deliveryMethod: "fixture", deliveryLabel: "Fixture",
      taxLabel: "fixture", taxMinor: 0, subtotalMinor: input.minor, discountMinor: 0, deliveryMinor: 0,
      totalMinor: input.minor, commerceEvidence: evidence, measurementTest: evidence === null ? null : evidence !== "production",
      items: { create: { variantId: "v-tote-oat", sku: "M11-TOTE", productName: "Recorded tote name", variantName: "Oat",
        quantity: 1, unitPriceMinor: input.minor, unitDiscountMinor: 0, lineTotalMinor: input.minor, currency,
        marketplaceShopId: input.merchant ?? storeShop.id, marketplaceShopNameSnapshot: input.merchant ? "Fixture independent merchant" : null } },
      payment: { create: { method, currency, amountMinor: input.minor, status: method === "COD" ? "AWAITING_COLLECTION" : "PAID", createdAt } },
    } });
    ids.push({ order: orderId, attempt: attemptId });
    return tx;
  }

  const outside = await order({ market: "bd", at: "2026-12-31T17:59:59Z", minor: 9000, shopper: buyer });
  const bdNew = await order({ market: "bd", at: "2026-12-31T18:00:00Z", minor: 12000, shopper: buyer, merchant: seller });
  const bdGuest = await order({ market: "bd", at: "2027-01-01T17:59:59Z", minor: 3000 });
  const production = await order({ market: "bd", at: "2027-01-01T00:01:00Z", minor: 5100, evidence: "production" });
  await order({ market: "bd", at: "2027-01-01T00:02:00Z", minor: 6777, evidence: null });
  await order({ market: "us", at: "2027-01-01T04:59:59Z", minor: 800 });
  const us = await order({ market: "us", at: "2027-01-01T05:00:00Z", minor: 2450 });

  await db.fulfillmentEvent.createMany({ data: [outside, bdNew].map((row, index) => ({
    orderId: row.id, type: "STATUS_CHANGED", status: "DELIVERED", createdAt: date("2027-01-01T0" + (index + 1) + ":10:00Z"),
  })) });
  await db.payment.update({ where: { orderId: outside.id }, data: { status: "COLLECTED", collectedAt: date("2027-01-01T03:10:00Z") } });
  await db.codRemittance.create({ data: { orderId: outside.id, attempt: 1, status: "MATCHED", reference: "TEST-REMIT",
    expectedGrossMinor: 9000, grossMinor: 9000, deductionsMinor: 250, netMinor: 8750, createdAt: date("2027-01-01T08:10:00Z") } });
  await db.orderCase.create({ data: { orderId: outside.id, kind: "RETURN", createdAt: date("2027-01-01T08:10:00Z"),
    returnReceivedAt: date("2027-01-01T12:40:00Z"), returnDisposition: "RESTOCK", refund: { create: { method: "COD", currency: "BDT", amountMinor: 1400, state: "CONFIRMED",
      authorizedAt: date("2027-01-01T09:10:00Z"), confirmedAt: date("2027-01-01T13:45:00Z"), providerRefundId: "TEST-" + outside.id } } } });
  await db.orderCase.create({ data: { orderId: bdNew.id, kind: "RETURN", createdAt: date("2027-01-01T11:10:00Z"),
    refund: { create: { method: "COD", currency: "BDT", amountMinor: 1700, state: "AUTHORIZED",
      authorizedAt: date("2027-01-01T13:15:00Z") } } } });
  await db.orderCase.create({ data: { orderId: us.id, kind: "RETURN", createdAt: date("2027-01-01T12:10:00Z"),
    refund: { create: { method: "PAYPAL", currency: "USD", amountMinor: 200, state: "CONFIRMED",
      authorizedAt: date("2027-01-01T13:15:00Z"), confirmedAt: date("2027-01-01T19:00:00Z"), providerRefundId: "TEST-" + us.id } } } });

  const bdReport = await loadOperationsReport(bdReporter, jan("bd", "daily", { compare: "previous" }));
  assert.equal(bdReport.comparison?.range.from, "2026-12-31");
  assert.equal(bdReport.comparison?.totals.bookedMinor, 9000);
  const { totals, registered, guestOrders, placedDelivered, unclassified } = bdReport.orders!;
  assert.deepEqual([totals.orders, totals.bookedMinor, registered, guestOrders, placedDelivered, unclassified], [2, 15000, 1, 1, 1, 1]);
  assert.deepEqual([totals.delivered, totals.onlineMinor, totals.codMinor, totals.remittedMinor, totals.refundedMinor], [2, 0, 9000, 8750, 1400]);
  assert.deepEqual([totals.returnRequests, totals.receivedReturns], [2, 1]);
  assert.equal(totals.onlineMinor + totals.codMinor - totals.refundedMinor, 7600);
  assert.equal(bdReport.orders?.daily[0].day, "2027-01-01");
  assert.deepEqual(bdReport.orders?.organizations.map(row => [row.label, row.merchandiseMinor]),
    [["Fixture independent merchant", 12000], ["GriipBuddy in-house", 3000]]);
  assert.deepEqual(bdReport.orders?.products.map(row => [row.label, row.units, row.merchandiseMinor]), [["Recorded tote name", 2, 15000]]);
  assert.equal(jan("bd").range.start.toISOString(), "2026-12-31T18:00:00.000Z");
  assert.equal(jan("us").range.start.toISOString(), "2027-01-01T05:00:00.000Z");
  const usReport = await loadOperationsReport(owner, jan("us"));
  assert.deepEqual([usReport.orders?.totals.orders, usReport.orders?.totals.onlineMinor, usReport.orders?.totals.refundedMinor], [1, 2450, 200]);
  const operating = await loadOperationsReport(owner, jan("bd", "activity", { mode: "operating" }));
  assert.deepEqual(operating.orders?.activity.map(row => row.orderId), [production.id]);
  const drilldown = await loadOperationsReport(bdOperations, jan("bd", "activity"));
  const csv = operationsCsv(drilldown)!;
  assert.match(csv, /"'=M11-/);
  assert.match(csv, /"bd","BDT","fixture"/);
  assert.ok(!csv.includes("private@example.invalid") && !csv.includes("Never exported") && !csv.includes(bdGuest.id));
  await assert.rejects(loadOperationsReport(bdReporter, jan("bd", "activity")), unavailable);
  await assert.rejects(loadOperationsReport(bdReporter, jan("us")), unavailable);
  await assert.rejects(loadOperationsReport(bdReporter, jan("bd", "stock")), unavailable);
  await db.staffMarketAccess.update({ where: { userId_marketId: { userId: bdReporter, marketId: "bd" } }, data: { reporting: false } });
  await assert.rejects(loadOperationsReport(bdReporter, jan("bd")), unavailable);
});

test("stock report separates authorized warehouse, owner, reservations and market eligibility", async t => {
  const owner = await staff("OWNER");
  const names = ["Fixture Dhaka", "Fixture New York"];
  const sites = await Promise.all((["bd", "us"] as const).map((marketId, index) => db.dispatchLocation.create({ data: {
    name: names[index], marketId, active: true, marketServices: { create: { marketId, active: true } },
  } })));
  const variantId = "v-tote-oat";
  const variant = await db.variant.findUniqueOrThrow({ where: { id: variantId } });
  await db.variant.update({ where: { id: variantId }, data: { managedInventory: true, optionSignature: "f".repeat(64) } });
  t.after(async () => {
    await db.inventoryPool.deleteMany({ where: { locationId: { in: sites.map(site => site.id) } } });
    await db.dispatchLocationMarket.deleteMany({ where: { locationId: { in: sites.map(site => site.id) } } });
    await db.dispatchLocation.deleteMany({ where: { id: { in: sites.map(site => site.id) } } });
    await db.variant.update({ where: { id: variantId }, data: { managedInventory: variant.managedInventory, optionSignature: variant.optionSignature } });
    await db.user.delete({ where: { id: owner } });
  });
  await db.inventoryPool.createMany({ data: sites.map((site, index) => ({ ownerId: storeShop.id, variantId,
    locationId: site.id, onHand: 7 + index, reserved: 3 + index })) });
  const bd = await loadOperationsReport(owner, jan("bd", "stock", { location: sites[0].id }));
  assert.deepEqual(bd.stock?.rows.map(row => [row.location, row.onHand, row.reserved, row.available]), [[names[0], 7, 3, 4]]);
  const us = await loadOperationsReport(owner, jan("us", "stock", { location: sites[1].id }));
  assert.deepEqual(us.stock?.rows.map(row => [row.location, row.onHand, row.reserved, row.available]), [[names[1], 8, 4, 4]]);
  await assert.rejects(loadOperationsReport(owner, jan("bd", "stock", { location: sites[1].id })), unavailable);
});

test("demand retains safe, consented and market-specific observations without individual identifiers", async t => {
  const owner = await staff("OWNER");
  const eventIds: string[] = [];
  const journeyIds: string[] = [];
  t.after(async () => {
    await db.measurementEvent.deleteMany({ where: { id: { in: eventIds } } });
    await db.measurementJourney.deleteMany({ where: { id: { in: journeyIds } } });
    await db.user.delete({ where: { id: owner } });
  });
  async function record(input: { term: string; count: number; market?: "us" | "bd"; automated?: boolean; test?: boolean }) {
    const journeyId = randomUUID(), id = randomUUID();
    journeyIds.push(journeyId);
    eventIds.push(id);
    const at = date("2027-01-01T09:00:00Z");
    await db.measurementEvent.create({ data: { id, kind: "SEARCH", marketId: input.market ?? "bd",
      sessionId: randomUUID(), details: { query: input.term, resultCount: input.count }, at,
      journey: { create: { id: journeyId, test: input.test ?? true, automated: input.automated ?? false, grantedAt: at, expiresAt: now } },
    } });
  }
  for (const count of [2, 0, 0]) await record({ term: "canvas case", count });
  await record({ term: "under threshold", count: 4 });
  await record({ term: "synthetic@example.invalid", count: 0 });
  await record({ term: "canvas case", count: 0, automated: true });
  await record({ term: "canvas case", count: 0, test: false });
  await record({ term: "canvas case", count: 0, market: "us" });
  const report = await loadOperationsReport(owner, jan("bd", "demand"));
  assert.deepEqual([report.demand?.searches, report.demand?.zeroResults], [5, 3]);
  assert.deepEqual(report.demand?.terms, [{ term: "canvas case", sessions: 3, zero: 2 }]);
  assert.ok(!operationsCsv(report)!.includes("@example.invalid"));
});

test("invalid report filters cannot extend the interval or override the configured currency", () => {
  for (const bad of [{ from: "2023-01-01" }, { to: "2027-01-08" }, { currency: "USD" }, { location: "../site" }, { market: ["bd", "us"] }]) {
    assert.throws(() => jan("bd", "daily", bad), (error: unknown) => error instanceof OperationsReportError && error.status === 400);
  }
});
