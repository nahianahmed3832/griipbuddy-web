import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { buyerOrderCase } from "../../src/lib/marketplace/cases.ts";
import { sellerCaseDetail, sellerCasePage } from "../../src/lib/marketplace/seller-cases.ts";
import { sellerOrderRange } from "../../src/lib/marketplace/seller-order-range.ts";
import {
  advanceSellerPreparation, sellerOrderDetail, sellerOrderPage, sellerOrdersCsv, sellerShop, SellerOrderError, staffSellerPreparation,
} from "../../src/lib/marketplace/seller-orders.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("seller reporting and handoff remain scoped for a mixed-shop order", async () => {
  const fixture = randomUUID();
  const buyers = [`${fixture}-buyer`, `${fixture}-owner-a`, `${fixture}-owner-b`];
  const [buyer, ownerA, ownerB] = buyers;
  const otherSeller = `${fixture}-owner-c`;
  const shopA = randomUUID();
  const shopB = randomUUID();
  const otherShop = randomUUID();
  const orderId = randomUUID();
  const attemptId = randomUUID();
  const reference = `SELLER-TEST-${fixture}`;
  const at = new Date("2026-11-17T17:59:59.999Z");
  const range = sellerOrderRange("2026-11-17", "2026-11-17");
  assert.ok(range);
  assert.equal(range.start.toISOString(), "2026-11-16T18:00:00.000Z");
  assert.equal(range.endExclusive.toISOString(), "2026-11-17T18:00:00.000Z");
  assert.equal(sellerOrderRange("2026-02-30", "2026-03-01"), null);

  try {
    await db.shopper.createMany({
      data: [...buyers, otherSeller].map(id => ({ id, email: `${id}@example.invalid`, name: "Seller report test" })),
    });
    await db.marketplaceShop.createMany({ data: [
      { id: shopA, ownerId: ownerA, slug: `shop-a-${fixture}`, name: "Shop A", about: "Synthetic fixture", announcement: "" },
      { id: shopB, ownerId: ownerB, slug: `shop-b-${fixture}`, name: "Shop B", about: "Synthetic fixture", announcement: "" },
      { id: otherShop, ownerId: otherSeller, slug: `shop-c-${fixture}`, name: "Shop C", about: "Synthetic fixture", announcement: "" },
    ] });
    const [variantA, variantB] = await db.variant.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: 2 });
    assert.ok(variantA && variantB, "Seed the database before running integration tests.");
    await db.checkoutAttempt.create({
      data: { id: attemptId, guestKey: randomBytes(32).toString("hex"), requestHash: randomBytes(32).toString("hex") },
    });
    await db.order.create({ data: {
      id: orderId, attemptId, reference, createdAt: at, shopperId: buyer, marketId: "bd", currency: "BDT",
      customerName: "Sensitive buyer fixture", phone: "01700000000", email: "private@example.invalid",
      district: "dhaka", districtLabel: "Dhaka", locality: "Test", address: "Hidden buyer address",
      deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "VAT",
      subtotalMinor: 2600, discountMinor: 200, deliveryMinor: 7000, taxMinor: 0, totalMinor: 9400,
      payment: { create: { method: "COD", status: "AWAITING_COLLECTION", amountMinor: 9400, currency: "BDT" } },
      items: { create: [
        { variantId: variantA.id, marketplaceShopId: shopA, productName: "=Seller A fixture", sku: "TEST-A",
          variantName: 'Frosted, "clear"', quantity: 2, unitPriceMinor: 1000, unitDiscountMinor: 100,
          lineTotalMinor: 1800, currency: "BDT", personalization: "Seller A engraving" },
        { variantId: variantB.id, marketplaceShopId: shopB, productName: "Seller B private line", sku: "TEST-B",
          variantName: "Glossy", quantity: 1, unitPriceMinor: 600, unitDiscountMinor: 0,
          lineTotalMinor: 600, currency: "BDT", personalization: "Seller B private engraving" },
      ] },
    } });

    assert.equal(await sellerShop(buyer), null);
    assert.equal((await sellerShop(ownerA))?.id, shopA);
    const reportA = await sellerOrderPage(shopA, range, 1);
    assert.equal(reportA.placed, 1);
    assert.equal(reportA.units, 2);
    assert.deepEqual(reportA.merchandise, [{ currency: "BDT", amountMinor: 1800 }]);
    assert.equal(reportA.orders[0]?.items[0]?.personalization, "Seller A engraving");
    assert.equal(reportA.orders[0]?.items.length, 1);
    assert.doesNotMatch(JSON.stringify(reportA.orders), /Seller B|Sensitive buyer|private@example\.invalid|Hidden buyer address/);
    const reportB = await sellerOrderPage(shopB, range, 1);
    assert.deepEqual(reportB.merchandise, [{ currency: "BDT", amountMinor: 600 }]);
    assert.equal(reportB.orders[0]?.items[0]?.sku, "TEST-B");
    assert.equal(reportB.orders[0]?.items.length, 1);
    const details = await sellerOrderDetail(shopA, orderId, "bd");
    assert.equal(details?.reference, reference);
    assert.deepEqual(details?.items.map(item => item.sku), ["TEST-A"]);
    assert.doesNotMatch(JSON.stringify(details), /Seller B|Sensitive buyer|private@example\.invalid|Hidden buyer address/);
    assert.equal(await sellerOrderDetail(otherShop, orderId, "bd"), null);
    assert.equal(await sellerOrderDetail(shopA, orderId, "us"), null);
    assert.equal(await sellerOrderDetail(shopA, "not-an-order-uuid", "bd"), null);

    const purchasedItems = await db.orderItem.findMany({
      where: { orderId }, select: { id: true, sku: true }, orderBy: { sku: "asc" },
    });
    const [purchaseA, purchaseB] = purchasedItems;
    const afterSales = await db.orderCase.create({ data: {
      orderId, kind: "RETURN", status: "IN_REVIEW", revision: 1,
      returnLines: { create: purchasedItems.map(purchase => ({ orderItemId: purchase.id, quantity: 1 })) },
      events: { create: [
        { revision: 0, status: "OPEN", note: "Buyer reason fixture." },
        { revision: 1, status: "IN_REVIEW", note: "Private operations note", publicNote: "Return review in progress." },
      ] },
    } });
    const foreignCase = await db.orderCase.create({ data: {
      orderId, kind: "CANCEL", returnLines: { create: { orderItemId: purchaseB.id, quantity: 1 } },
    } });
    await db.orderCase.create({ data: { orderId, kind: "DISPUTE" } });
    const requests = await sellerCasePage(shopA, "bd", 1, { q: reference });
    assert.deepEqual(requests.rows.map(row => row.id), [afterSales.id]);
    const sellerRequest = await sellerCaseDetail(shopA, "bd", afterSales.id);
    assert.deepEqual(sellerRequest?.returnLines.map(line => line.orderItem.id), [purchaseA.id]);
    assert.doesNotMatch(JSON.stringify(sellerRequest), /Seller B|Buyer reason|Private operations note|Hidden buyer address/);
    assert.equal(await sellerCaseDetail(shopA, "bd", foreignCase.id), null);
    assert.equal(await sellerCaseDetail(shopA, "us", afterSales.id), null);
    assert.equal(await sellerCaseDetail(otherShop, "bd", afterSales.id), null);
    assert.equal(await buyerOrderCase(ownerA, orderId, afterSales.id), null);
    const buyerRequest = await buyerOrderCase(buyer, orderId, afterSales.id);
    assert.deepEqual(buyerRequest?.events.map(event => event.note), ["Buyer reason fixture.", "Return review in progress."]);
    assert.doesNotMatch(JSON.stringify(buyerRequest), /Private operations note/);

    const csv = await sellerOrdersCsv(shopA, range);
    assert.match(csv, /"'=Seller A fixture"/);
    assert.match(csv, /"Frosted, ""clear"""/);
    assert.doesNotMatch(csv, /Seller B|Buyer|private@example\.invalid|engraving/);
    const nextDay = sellerOrderRange("2026-11-18", "2026-11-18");
    assert.ok(nextDay);
    assert.equal((await sellerOrdersCsv(shopA, nextDay)).split("\r\n").filter(Boolean).length, 1);

    const rejected = (status: number) => (error: unknown) => error instanceof SellerOrderError && error.status === status;
    await assert.rejects(advanceSellerPreparation(buyer, { orderId, next: "PREPARING" }), rejected(404));
    await assert.rejects(advanceSellerPreparation(otherSeller, { orderId, marketId: "bd", next: "PREPARING" }), rejected(404));
    await assert.rejects(advanceSellerPreparation(ownerA, { orderId, marketId: "us", next: "PREPARING" }), rejected(404));
    await assert.rejects(advanceSellerPreparation(ownerA, { orderId, next: "HANDED_OFF" }), rejected(409));
    const retries = await Promise.all([
      advanceSellerPreparation(ownerA, { orderId, next: "PREPARING" }),
      advanceSellerPreparation(ownerA, { orderId, next: "PREPARING" }),
    ]);
    assert.deepEqual(retries, [{ status: "PREPARING" }, { status: "PREPARING" }]);
    await advanceSellerPreparation(ownerA, { orderId, next: "READY" });
    await advanceSellerPreparation(ownerA, { orderId, next: "HANDED_OFF" });
    const staffView = await staffSellerPreparation(orderId, [shopA, shopB]);
    assert.equal(staffView[0]?.fulfillments[0]?.status, "HANDED_OFF");
    assert.deepEqual(staffView[1]?.fulfillments, []);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus, "UNFULFILLED");
    await db.payment.update({ where: { orderId }, data: { method: "SSLCOMMERZ", status: "REFUND_PENDING" } });
    await assert.rejects(advanceSellerPreparation(ownerB, { orderId, next: "PREPARING" }), rejected(409));
    await db.payment.update({ where: { orderId }, data: { status: "PAID" } });
    await advanceSellerPreparation(ownerB, { orderId, next: "PREPARING" });
    await db.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
    await assert.rejects(advanceSellerPreparation(ownerB, { orderId, next: "READY" }), rejected(409));
    assert.equal((await sellerOrderPage(shopA, range, 1)).placed, 0);
  } finally {
    await db.orderCase.deleteMany({ where: { orderId } });
    await db.orderItem.deleteMany({ where: { orderId } });
    await db.payment.deleteMany({ where: { orderId } });
    await db.order.deleteMany({ where: { id: orderId } });
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
    await db.marketplaceShop.deleteMany({ where: { id: { in: [shopA, shopB, otherShop] } } });
    await db.shopper.deleteMany({ where: { id: { in: [...buyers, otherSeller] } } });
  }
});
