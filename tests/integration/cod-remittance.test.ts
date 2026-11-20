import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { commerceOutcomeSelect, projectCommerceOutcomes } from "../../src/lib/measurement/outcomes.ts";
import { codReconciliationOrder, listCodReconciliation, recordCodRemittance, summarizeCodReconciliation } from "../../src/lib/staff/cod-remittance.ts";
import { advanceFulfillment, collectCash, recordBangladeshTracking } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.GRIIP_HYBRID_STOREFRONT = "1";
const db = getDb();
const variantId = "v-tote-oat";
const input: CheckoutDetails = {
  marketId: "bd", items: [{ variantId, quantity: 1 }],
  customer: {
    name: "COD Test Shopper", phone: "01700000000", district: "dhaka", locality: "Dhanmondi",
    address: "Synthetic delivery address for testing", email: "cod-test@example.test",
  },
  paymentMethod: "COD", deliveryMethod: "standard",
};

after(() => db.$disconnect());

function withAmount(stage: { orders: number; amountMinor: number }, amountMinor: number) {
  return { orders: stage.orders + 1, amountMinor: stage.amountMinor + amountMinor };
}

async function placeAndDispatch(t: TestContext) {
  const [owner, packer] = await Promise.all([
    db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } }),
    db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true } }),
  ]);
  const guest = randomBytes(32).toString("hex");
  const review = await reviewCheckout(input, "bd", guest);
  assert.equal(review.kind, "review");
  const result = await submitCheckout({ ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken }, "bd", guest);
  assert.equal(result.kind, "placed");
  const { orderId } = result;
  t.after(() => db.$transaction(async (tx) => {
    await tx.codRemittance.deleteMany({ where: { orderId } });
    await tx.auditEvent.deleteMany({ where: { target: orderId } });
    await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
    await tx.bangladeshShipmentEvent.deleteMany({ where: { orderId } });
    await tx.bangladeshShipment.deleteMany({ where: { orderId } });
    await tx.payment.delete({ where: { orderId } });
    await tx.orderItem.deleteMany({ where: { orderId } });
    await tx.order.delete({ where: { id: orderId } });
    await tx.checkoutAttempt.delete({ where: { id: review.attemptId } });
    await tx.inventory.update({ where: { variantId }, data: { available: { increment: 1 } } });
  }));
  await advanceFulfillment(packer.userId, orderId, { next: "PACKING" });
  await advanceFulfillment(packer.userId, orderId, { next: "READY_TO_SHIP" });
  await advanceFulfillment(packer.userId, orderId, { next: "SHIPPED", carrier: "Manual test courier", trackingReference: randomUUID() });
  const payment = await db.payment.findUniqueOrThrow({ where: { orderId } });
  return { orderId, owner: owner.userId, packer: packer.userId, grossMinor: payment.amountMinor };
}

test("delivered Bangladesh COD follows collection, discrepancy and matched remittance once", async (t) => {
  const { orderId, owner, packer, grossMinor } = await placeAndDispatch(t);
  const deductionsMinor = 3500;
  const matched = { reference: "TEST-STATEMENT-01", grossMinor, deductionsMinor, netMinor: grossMinor - deductionsMinor };
  const discrepancy = { ...matched, netMinor: matched.netMinor - 1 };
  const initial = await summarizeCodReconciliation(owner);
  assert.ok((await listCodReconciliation(owner, "awaiting-delivery", 1)).rows.some(row => row.id === orderId));
  await assert.rejects(summarizeCodReconciliation(packer), /permission/);
  await assert.rejects(recordCodRemittance(owner, orderId, matched), /delivered.*collection recorded/);
  await recordBangladeshTracking(packer, orderId, { status: "DELIVERED", evidence: "synthetic delivery receipt" });
  const afterDelivery = { ...initial, delivered: withAmount(initial.delivered, grossMinor) };
  assert.deepEqual(await summarizeCodReconciliation(owner), afterDelivery);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId } })).status, "AWAITING_COLLECTION");
  const delivered = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: commerceOutcomeSelect });
  assert.deepEqual(projectCommerceOutcomes(delivered, new Date()).map(event => event.kind), ["ORDER_ACCEPTED", "ORDER_DELIVERED"]);
  assert.ok((await listCodReconciliation(owner, "awaiting-collection", 1)).rows.some(row => row.id === orderId));
  await assert.rejects(recordCodRemittance(owner, orderId, matched), /collection recorded/);
  await collectCash(owner, orderId);
  const afterCollection = { ...afterDelivery, collected: withAmount(initial.collected, grossMinor) };
  assert.deepEqual(await summarizeCodReconciliation(owner), afterCollection);
  assert.ok((await listCodReconciliation(owner, "awaiting-remittance", 1)).rows.some(row => row.id === orderId));
  await assert.rejects(recordCodRemittance(packer, orderId, matched), /permission/);
  await assert.rejects(listCodReconciliation(packer, "awaiting-remittance", 1), /permission/);

  assert.deepEqual(await Promise.all([
    recordCodRemittance(owner, orderId, discrepancy), recordCodRemittance(owner, orderId, discrepancy),
  ]), ["DISCREPANCY", "DISCREPANCY"]);
  assert.ok((await listCodReconciliation(owner, "discrepancy", 1)).rows.some(row => row.id === orderId));
  assert.deepEqual(await summarizeCodReconciliation(owner), afterCollection);
  assert.deepEqual(await Promise.all([
    recordCodRemittance(owner, orderId, matched), recordCodRemittance(owner, orderId, matched),
  ]), ["MATCHED", "MATCHED"]);
  await assert.rejects(recordCodRemittance(owner, orderId, { ...matched, reference: "TEST-STATEMENT-02" }), /already matched/);
  assert.equal(await recordCodRemittance(owner, orderId, discrepancy), "DISCREPANCY");

  const order = await codReconciliationOrder(owner, orderId);
  assert.equal(order?.canRecord, false);
  assert.equal(order.payment.status, "COLLECTED");
  assert.ok(order.deliveredAt instanceof Date);
  assert.ok(order.payment.collectedAt instanceof Date);
  assert.deepEqual(await summarizeCodReconciliation(owner), { ...afterCollection, received: withAmount(initial.received, matched.netMinor) });
  assert.deepEqual(order.codRemittances.map(row => ({ reference: row.reference, grossMinor: row.grossMinor,
    deductionsMinor: row.deductionsMinor, netMinor: row.netMinor, status: row.status })), [
    { ...matched, status: "MATCHED" }, { ...discrepancy, status: "DISCREPANCY" },
  ]);
  assert.ok((await listCodReconciliation(owner, "matched", 1)).rows.some(row => row.id === orderId));
  assert.ok(!(await listCodReconciliation(owner, "discrepancy", 1)).rows.some(row => row.id === orderId));
  const remitted = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: commerceOutcomeSelect });
  const outcomes = projectCommerceOutcomes(remitted, new Date());
  assert.deepEqual(outcomes.map(event => [event.kind, event.amountMinor]), [
    ["ORDER_ACCEPTED", grossMinor], ["ORDER_DELIVERED", null], ["COD_COLLECTED", grossMinor], ["COD_REMITTED", matched.netMinor],
  ]);
  assert.equal(outcomes.at(-1)?.deductionsMinor, deductionsMinor);
  assert.deepEqual(outcomes.slice(0, 2).map(({ id }) => id), projectCommerceOutcomes(delivered, new Date()).map(({ id }) => id));
});

test("a refused Bangladesh delivery voids COD and cannot be reconciled", async (t) => {
  const { orderId, owner, grossMinor } = await placeAndDispatch(t);
  await recordBangladeshTracking(owner, orderId, { status: "REFUSED", evidence: "synthetic refusal receipt" });
  await assert.rejects(collectCash(owner, orderId), /after the order is delivered/);
  await assert.rejects(recordCodRemittance(owner, orderId, {
    reference: "TEST-NO-REMITTANCE", grossMinor, deductionsMinor: 0, netMinor: grossMinor,
  }), /delivered.*collection recorded/);
  const order = await codReconciliationOrder(owner, orderId);
  assert.equal(order?.bangladeshShipment?.status, "REFUSED");
  assert.equal(order.payment.status, "VOIDED");
  assert.equal(order.payment.collectedAt, null);
  assert.equal(order.canRecord, false);
  assert.deepEqual(order.codRemittances, []);
  assert.ok((await listCodReconciliation(owner, "voided", 1)).rows.some(row => row.id === orderId));
  const refused = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: commerceOutcomeSelect });
  assert.deepEqual(projectCommerceOutcomes(refused, new Date()).map(event => event.kind), ["ORDER_ACCEPTED", "ORDER_REFUSED"]);
});
