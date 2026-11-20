import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { sellerOrderRange } from "../../src/lib/marketplace/seller-order-range.ts";
import { sellerStatement } from "../../src/lib/marketplace/seller-statements.ts";
import { recordCodRemittance } from "../../src/lib/staff/cod-remittance.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("Bangladesh COD statements reconcile seller shares and approved returns using sample order snapshots", async t => {
  const fixture = randomUUID();
  const [buyerId, ownerA, ownerB] = ["buyer", "a", "b"].map(role => `${role}-${fixture}`);
  const [shopA, shopB] = [randomUUID(), randomUUID()];
  const attemptIds: string[] = [];
  const staff = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const [variantA, variantB, firstPartyVariant] = await db.variant.findMany({ select: { id: true }, orderBy: { id: "asc" }, take: 3 });
  assert.ok(variantA && variantB && firstPartyVariant, "Seed the catalog before testing statements.");
  t.after(() => db.$transaction(async tx => {
    const orders = await tx.order.findMany({ where: { attemptId: { in: attemptIds } }, select: { id: true } });
    const orderIds = orders.map(order => order.id);
    const byOrder = { orderId: { in: orderIds } };
    await tx.orderCase.deleteMany({ where: byOrder });
    await tx.codRemittance.deleteMany({ where: byOrder });
    await tx.bangladeshShipmentEvent.deleteMany({ where: byOrder });
    await tx.bangladeshShipment.deleteMany({ where: byOrder });
    await tx.payment.deleteMany({ where: byOrder });
    await tx.orderItem.deleteMany({ where: byOrder });
    await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    await tx.checkoutAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await tx.marketplaceShop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
    await tx.shopper.deleteMany({ where: { id: { in: [buyerId, ownerA, ownerB] } } });
  }));
  await db.shopper.createMany({ data: [buyerId, ownerA, ownerB].map(id => ({ id, email: `${id}@example.invalid`, name: "Statement fixture" })) });
  await db.marketplaceShop.createMany({ data: [
    { id: shopA, ownerId: ownerA, slug: `statement-a-${fixture}`, name: "Shop A", about: "Fixture", announcement: "" },
    { id: shopB, ownerId: ownerB, slug: `statement-b-${fixture}`, name: "Shop B", about: "Fixture", announcement: "" },
  ] });
  const range = sellerOrderRange("2026-10-20", "2026-10-21");
  assert.ok(range);
  const deliveredAt = new Date("2026-10-22T03:00:00.000Z");
  const collectedAt = new Date("2026-10-22T07:00:00.000Z");

  async function orderFixture(reference: string, stage: "shipped" | "delivered" | "collected" | "refused", createdAt: Date, measurementTest = true) {
    const attemptId = randomUUID();
    attemptIds.push(attemptId);
    await db.checkoutAttempt.create({ data: { id: attemptId, guestKey: randomBytes(32).toString("hex"), requestHash: randomBytes(32).toString("hex") } });
    const delivered = stage === "delivered" || stage === "collected";
    const paid = stage === "collected";
    return db.order.create({
      data: {
        attemptId,
        reference: `${reference}-${fixture}`, createdAt, shopperId: buyerId, marketId: "bd", currency: "BDT", measurementTest,
        fulfillmentStatus: delivered ? "DELIVERED" : "SHIPPED", customerName: "Private Fixture Customer", phone: "01700000000",
        email: "private-statement@example.invalid", district: "dhaka", districtLabel: "Dhaka", locality: "Test", address: "Private fixture address",
        deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "VAT",
        subtotalMinor: 22000, discountMinor: 2000, couponCode: "QA-STMT-10", couponDiscountMinor: 1000,
        deliveryMinor: 2000, taxMinor: 1000, totalMinor: 23000,
        payment: { create: {
          method: "COD", status: paid ? "COLLECTED" : stage === "refused" ? "VOIDED" : "AWAITING_COLLECTION",
          currency: "BDT", amountMinor: 23000, collectedAt: paid ? collectedAt : null,
        } },
        bangladeshShipment: { create: {
          carrier: "Statement test courier", trackingReference: randomUUID(), source: "MANUAL",
          status: delivered ? "DELIVERED" : stage === "refused" ? "REFUSED" : "IN_TRANSIT",
          statusUpdatedAt: deliveredAt,
        } },
        items: { create: [
          { variantId: variantA.id, marketplaceShopId: shopA, productName: "Seller A fixture item", variantName: "A", sku: "QA-STMT-A", quantity: 2,
            unitPriceMinor: 6000, unitDiscountMinor: 500, couponDiscountMinor: 1000, lineTotalMinor: 10000, currency: "BDT" },
          { variantId: variantB.id, marketplaceShopId: shopB, productName: "Seller B fixture item", variantName: "B", sku: "QA-STMT-B", quantity: 1,
            unitPriceMinor: 6000, unitDiscountMinor: 0, lineTotalMinor: 6000, currency: "BDT" },
          { variantId: firstPartyVariant.id, productName: "First-party fixture item", variantName: "Store", sku: "QA-STMT-STORE", quantity: 1,
            unitPriceMinor: 4000, unitDiscountMinor: 0, lineTotalMinor: 4000, currency: "BDT" },
        ] },
      },
      include: { items: true },
    });
  }

  const placedAt = range.start;
  const matched = await orderFixture("QA-MATCHED", "collected", placedAt);
  const disputed = await orderFixture("QA-DISCREPANCY", "collected", placedAt);
  const delivered = await orderFixture("QA-DELIVERED", "delivered", placedAt);
  const shipped = await orderFixture("QA-SHIPPED", "shipped", placedAt);
  const refused = await orderFixture("QA-REFUSED", "refused", placedAt);
  await orderFixture("QA-OUT-OF-RANGE", "delivered", range.endExclusive);
  await orderFixture("QA-NONTEST", "delivered", placedAt, false);
  const unmatchedReceipt = { reference: "QA-RECEIPT", grossMinor: 23000, deductionsMinor: 501, netMinor: 22498 };
  assert.equal(await recordCodRemittance(staff.userId, matched.id, unmatchedReceipt), "DISCREPANCY");
  assert.equal(await recordCodRemittance(staff.userId, matched.id, { ...unmatchedReceipt, netMinor: 22499 }), "MATCHED");
  assert.equal(await recordCodRemittance(staff.userId, disputed.id, unmatchedReceipt), "DISCREPANCY");
  const returned = matched.items.find(item => item.marketplaceShopId === shopA);
  assert.ok(returned);
  await db.orderCase.create({ data: {
    orderId: matched.id, kind: "RETURN", status: "REFUND_APPROVED", refundAmountMinor: 5250,
    returnReceivedAt: new Date("2026-10-23T03:00:00.000Z"), returnDisposition: "RESTOCK",
    returnLines: { create: { orderItemId: returned.id, quantity: 1 } },
  } });

  assert.equal(await sellerStatement(buyerId, range), null);
  const [statementA, statementB] = await Promise.all([sellerStatement(ownerA, range), sellerStatement(ownerB, range)]);
  assert.ok(statementA && statementB);
  assert.equal(statementA.shop.name, "Shop A");
  assert.equal(statementA.currency, "BDT");
  assert.equal(statementA.commissionBasisPoints, 1000);
  assert.deepEqual(new Set(statementA.rows.map(row => row.orderId)), new Set([matched.id, disputed.id, delivered.id, shipped.id, refused.id]));
  const settledA = statementA.rows.find(row => row.orderId === matched.id);
  const settledB = statementB.rows.find(row => row.orderId === matched.id);
  assert.ok(settledA && settledB);
  assert.deepEqual([settledA.delivery, settledA.collection, settledA.remittance], ["DELIVERED", "COLLECTED", "MATCHED"]);
  assert.equal(settledA.grossSalesMinor, 12000);
  assert.equal(settledA.discountsMinor, 2000);
  assert.equal(settledA.buyerShippingMinor, 1000);
  assert.equal(settledA.collectedMinor, 11500);
  assert.equal(settledA.remittedMinor, 11249);
  assert.equal(settledA.courierFeesMinor, 251);
  assert.equal(settledA.approvedRefundsMinor, 5250);
  assert.equal(settledA.returnsMinor, 5000);
  assert.equal(settledA.returnedUnits, 1);
  assert.equal(settledA.commissionMinor, 500);
  assert.equal(settledA.balanceOwedMinor, 4249);
  assert.equal(settledB.collectedMinor, 6900);
  assert.equal(settledB.remittedMinor, 6750);
  assert.equal(settledB.courierFeesMinor, 150);
  assert.equal(settledB.approvedRefundsMinor, 0);
  assert.equal(settledB.balanceOwedMinor, 5250);

  const stages = statementA.rows.map(row => [row.orderId, row.delivery, row.collection, row.remittance, row.balanceOwedMinor]);
  assert.ok(stages.some(([id, delivery, collection, remittance, balance]) => id === disputed.id && delivery === "DELIVERED" && collection === "COLLECTED" && remittance === "DISCREPANCY" && balance === 0));
  assert.ok(stages.some(([id, delivery, collection, remittance, balance]) => id === delivered.id && delivery === "DELIVERED" && collection === "PENDING" && remittance === "UNRECORDED" && balance === 0));
  assert.ok(stages.some(([id, delivery, collection, , balance]) => id === shipped.id && delivery === "PENDING" && collection === "PENDING" && balance === 0));
  assert.ok(stages.some(([id, delivery, collection, , balance]) => id === refused.id && delivery === "REFUSED" && collection === "VOIDED" && balance === 0));
  assert.equal(statementA.totals.balanceOwedMinor, settledA.balanceOwedMinor);
  assert.equal(statementA.totals.remittedMinor, settledA.remittedMinor);
  assert.doesNotMatch(JSON.stringify(statementA), /Seller B fixture item|QA-STMT-B|Private Fixture Customer|private-statement@example|Private fixture address/);
});
