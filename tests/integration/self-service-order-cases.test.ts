import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { caseCommand } from "../../src/lib/marketplace/case-policy.ts";
import { buyerOrderCase, executeOrderCase, returnItemsForPurchase, staffOrderCase } from "../../src/lib/marketplace/cases.ts";
import { advanceFulfillment, cancelOrder, collectCash } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
const db = getDb();
after(() => db.$disconnect());

const orderedVariant = "v-tee-sage-s";
const sizeReplacement = "v-tee-sage-m";
const note = "Requested the next size after trying on the item.";

async function available(variantId = orderedVariant) {
  return (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
}

async function dispatch(actorId: string, orderId: string) {
  await advanceFulfillment(actorId, orderId, { next: "PACKING" });
  await advanceFulfillment(actorId, orderId, { next: "READY_TO_SHIP" });
  await advanceFulfillment(actorId, orderId, { next: "SHIPPED", carrier: "Fixture courier", trackingReference: "QA-HANDOFF" });
}

async function purchase(t: TestContext) {
  const buyerId = `case-buyer-${randomUUID()}`;
  const guestKey = randomBytes(32).toString("hex");
  const ownerAccess = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const buyer = { id: buyerId, role: "shopper" } as const;
  const owner = { id: ownerAccess.userId, role: "owner" } as const;
  const startingStock = await available();
  const replacementStock = await available(sizeReplacement);
  await db.shopper.create({ data: { id: buyerId, email: `${buyerId}@example.test`, name: "Self-service case shopper" } });
  const fixture: { attemptId?: string; orderId?: string } = {};
  t.after(async () => {
    const { orderId, attemptId } = fixture;
    await db.$transaction(async tx => {
      if (orderId) {
        const cases = await tx.orderCase.findMany({ where: { orderId }, select: { id: true } });
        await tx.auditEvent.deleteMany({ where: { target: { in: [orderId, ...cases.map(row => row.id)] } } });
        await tx.orderCase.deleteMany({ where: { orderId } });
        await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
        await tx.payment.deleteMany({ where: { orderId } });
        await tx.orderItem.deleteMany({ where: { orderId } });
        await tx.order.delete({ where: { id: orderId } });
        await tx.inventory.update({ where: { variantId: orderedVariant }, data: { available: startingStock } });
        await tx.inventory.update({ where: { variantId: sizeReplacement }, data: { available: replacementStock } });
      }
      if (attemptId) await tx.checkoutAttempt.delete({ where: { id: attemptId } });
      await tx.shopper.delete({ where: { id: buyerId } });
    });
  });
  const checkout: CheckoutDetails = {
    marketId: "bd", items: [{ variantId: orderedVariant, quantity: 2 }],
    customer: { name: "Self-service case shopper", phone: "01700000000", district: "dhaka", locality: "Dhanmondi", address: "Test delivery address" },
    deliveryMethod: "standard", paymentMethod: "COD",
  };
  const quote = await reviewCheckout(checkout, "bd", guestKey);
  assert.equal(quote.kind, "review");
  fixture.attemptId = quote.attemptId;
  const placed = await submitCheckout({ ...checkout, attemptId: quote.attemptId, reviewToken: quote.quote.reviewToken }, "bd", guestKey, buyerId);
  assert.equal(placed.kind, "placed");
  const orderId = placed.orderId;
  fixture.orderId = orderId;
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId, variantId: orderedVariant } });
  return { owner, buyer, orderId, item, startingStock, replacementStock };
}

test("an active cancellation request holds dispatch and approval restores the unshipped COD order once", async t => {
  const { owner, buyer, orderId, startingStock } = await purchase(t);
  await advanceFulfillment(owner.id, orderId, { next: "PACKING" });
  await advanceFulfillment(owner.id, orderId, { next: "READY_TO_SHIP" });
  const request = caseCommand.parse({ action: "open", orderId, kind: "CANCEL", note: "I ordered this twice and need to cancel the duplicate." });
  const { id: caseId } = await executeOrderCase(buyer, request);
  assert.equal(await available(), startingStock - 2);
  await assert.rejects(advanceFulfillment(owner.id, orderId, { next: "SHIPPED", carrier: "Fixture courier", trackingReference: "TEST-CANCEL" }), /cancellation/i);
  await assert.rejects(cancelOrder(owner.id, orderId), /cancellation case/i);
  await executeOrderCase(owner, { action: "review", caseId, revision: 0, status: "IN_REVIEW", note: "Order is still in our warehouse." });
  const approval = { action: "approve-cancellation", caseId, revision: 1, note: "The order was cancelled before handoff." } as const;
  assert.throws(() => executeOrderCase(buyer, approval), { status: 403 });
  const outcomes = await Promise.allSettled([executeOrderCase(owner, approval), executeOrderCase(owner, approval)]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status, "CANCELLED");
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId } })).status, "VOIDED");
  assert.equal(await available(), startingStock);
  const closed = await buyerOrderCase(buyer.id, orderId, caseId);
  assert.equal(closed?.kind, "CANCEL");
  assert.equal(closed?.status, "RESOLVED");
});

test("size exchange requires pickup receipt before dispatch and consumes only the selected quantities", async t => {
  const { owner, buyer, orderId, item, startingStock, replacementStock } = await purchase(t);
  await dispatch(owner.id, orderId);
  await assert.rejects(executeOrderCase(buyer, { action: "open", orderId, kind: "CANCEL", note }), { status: 409 });
  const line = { orderItemId: item.id, quantity: 1, replacementVariantId: sizeReplacement };
  const request = { action: "open", orderId, kind: "EXCHANGE", note, lines: [line] } as const;
  await assert.rejects(executeOrderCase(buyer, caseCommand.parse(request)), { status: 409 });
  await advanceFulfillment(owner.id, orderId, { next: "DELIVERED" });
  await collectCash(owner.id, orderId);
  await assert.rejects(executeOrderCase(buyer, { ...request, lines: [{ ...line, replacementVariantId: orderedVariant }] }), { status: 409 });
  await assert.rejects(executeOrderCase(buyer, { ...request, lines: [{ ...line, replacementVariantId: "v-tote-oat" }] }), { status: 409 });
  const { id: caseId } = await executeOrderCase(buyer, caseCommand.parse(request));
  const review = { action: "review", caseId, note: "Approved the item and requested replacement." } as const;
  await executeOrderCase(owner, { ...review, revision: 0, status: "IN_REVIEW" });
  await executeOrderCase(owner, { ...review, revision: 1, status: "RETURN_APPROVED" });
  const pickupAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await executeOrderCase(owner, { action: "schedule-pickup", caseId, revision: 2, pickupAt, pickupReference: "QA-PICKUP", note: "Courier pickup arranged." });
  const exchange = { action: "ship-exchange", caseId, trackingReference: "QA-REPLACEMENT", note: "Confirmed replacement handoff." } as const;
  await assert.rejects(executeOrderCase(owner, { ...exchange, revision: 3 }), { status: 409 });
  assert.equal(await available(), startingStock - 2);
  await executeOrderCase(owner, { action: "receive", caseId, revision: 3, disposition: "RESTOCK", confirmed: true });
  assert.equal(await available(), startingStock - 1);
  assert.equal(await available(sizeReplacement), replacementStock);
  await db.inventory.update({ where: { variantId: sizeReplacement }, data: { available: 0 } });
  await assert.rejects(executeOrderCase(owner, { ...exchange, revision: 4 }), { status: 409 });
  assert.equal((await buyerOrderCase(buyer.id, orderId, caseId))?.status, "RETURN_RECEIVED");
  await db.inventory.update({ where: { variantId: sizeReplacement }, data: { available: replacementStock } });
  const shipments = await Promise.allSettled([
    executeOrderCase(owner, { ...exchange, revision: 4 }), executeOrderCase(owner, { ...exchange, revision: 4 }),
  ]);
  assert.equal(shipments.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(await available(sizeReplacement), replacementStock - 1);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId } })).status, "COLLECTED");
  const visible = await buyerOrderCase(buyer.id, orderId, caseId);
  assert.equal(visible?.pickupAt?.toISOString(), pickupAt);
  assert.equal(visible?.replacementTrackingReference, "QA-REPLACEMENT");
  assert.equal(visible?.returnLines[0].replacementVariantName, "Sage / M");
  assert.deepEqual((await returnItemsForPurchase(orderId, buyer.id)).map(row => row.quantity), [1]);
});

async function checkItemRefund(t: TestContext, kind: "RETURN" | "EXCHANGE") {
  const { owner, buyer, orderId, item, startingStock } = await purchase(t);
  await dispatch(owner.id, orderId);
  await advanceFulfillment(owner.id, orderId, { next: "DELIVERED" });
  await collectCash(owner.id, orderId);
  const payment = await db.payment.findUniqueOrThrow({ where: { orderId } });
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  const line = { orderItemId: item.id, quantity: 1, ...(kind === "EXCHANGE" && { replacementVariantId: sizeReplacement }) };
  const { id: caseId } = await executeOrderCase(buyer, { action: "open", orderId, kind, note, lines: [line] });
  const review = { action: "review", caseId, note: "Agreed to inspect the shopper’s return." } as const;
  await executeOrderCase(owner, { ...review, revision: 0, status: "IN_REVIEW" });
  await executeOrderCase(owner, { ...review, revision: 1, status: "RETURN_APPROVED" });
  const merchandiseMinor = Math.floor(item.lineTotalMinor / item.quantity);
  const amountMinor = merchandiseMinor + Math.floor(order.taxMinor * merchandiseMinor / (order.subtotalMinor - order.discountMinor));
  const refund = { action: "approve-refund", caseId, amountMinor, note: "Approved the merchandise refund for the returned unit." } as const;
  await assert.rejects(executeOrderCase(owner, { ...refund, revision: 2 }), { status: 409 });
  await executeOrderCase(owner, { action: "receive", caseId, revision: 2, disposition: "HOLD", confirmed: true });
  await assert.rejects(executeOrderCase(owner, { ...refund, revision: 3, amountMinor: amountMinor + 1 }), { status: 409 });
  await executeOrderCase(owner, { ...refund, revision: 3 });
  assert.equal((await staffOrderCase(owner.id, caseId))?.refundAmountMinor, amountMinor);
  assert.equal((await buyerOrderCase(buyer.id, orderId, caseId))?.status, "REFUND_APPROVED");
  assert.equal(await available(), startingStock - 2);
  assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { orderId } }), payment);
  if (kind === "EXCHANGE") {
    await assert.rejects(executeOrderCase(owner, {
      action: "ship-exchange", caseId, revision: 4, trackingReference: "QA-REPLACEMENT", note: "The replacement cannot ship after refund approval.",
    }), { status: 409 });
  }
}

test("return refund approval follows inspection and uses the purchased item and tax to cap the amount", t => checkItemRefund(t, "RETURN"));
test("refund approval for an inspected exchange prevents replacement dispatch", t => checkItemRefund(t, "EXCHANGE"));

test("prepaid cancellation records refund approval and leaves payment pending settlement", async t => {
  const { owner, buyer, orderId, startingStock } = await purchase(t);
  const payment = await db.payment.update({ where: { orderId }, data: { method: "SSLCOMMERZ", status: "PAID" } });
  const { id: caseId } = await executeOrderCase(buyer, { action: "open", orderId, kind: "CANCEL", note: "Please cancel this order before it ships." });
  await executeOrderCase(owner, { action: "review", caseId, revision: 0, status: "IN_REVIEW", note: "Prepaid order confirmed in the warehouse." });
  await assert.rejects(executeOrderCase(owner, { action: "approve-cancellation", caseId, revision: 1, note: "This payment would need a refund." }), { status: 409 });
  const refund = { action: "approve-refund", caseId, revision: 1, amountMinor: payment.amountMinor, note: "Full refund approved for the cancellation." } as const;
  await assert.rejects(executeOrderCase(owner, { ...refund, amountMinor: payment.amountMinor - 1 }), { status: 409 });
  await executeOrderCase(owner, refund);
  const approved = await buyerOrderCase(buyer.id, orderId, caseId);
  assert.equal(approved?.status, "REFUND_APPROVED");
  assert.equal(approved?.refundAmountMinor, payment.amountMinor);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId } })).status, "REFUND_PENDING");
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status, "CANCELLED");
  assert.equal(await available(), startingStock);
});
