import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import {
  buyerOrderCase, exchangeVariantsForPurchase, executeOrderCase, returnItemsForPurchase, staffOrderCase,
} from "../../src/lib/marketplace/cases.ts";
import { advanceFulfillment, collectCash } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
const db = getDb();
after(() => db.$disconnect());

test("Bangladesh cancellation, return and exchange actions preserve ownership, inventory and refund evidence", async t => {
  const suffix = randomUUID();
  const buyer = { id: `after-sales-${suffix}`, role: "shopper", market: "bd" } as const;
  const other = { ...buyer, id: `after-sales-other-${suffix}` };
  const owner = { id: (await db.staffAccess.findFirstOrThrow({
    where: { active: true, role: "OWNER", marketIds: { has: "bd" } },
  })).userId, market: "bd", role: "owner" } as const;
  const variantId = "v-tee-sage-s";
  const replacementId = "v-tee-sage-m";
  const stock = async (id: string) => (await db.inventory.findUniqueOrThrow({ where: { variantId: id } })).available;
  const originalStock = await stock(variantId);
  const replacementStock = await stock(replacementId);
  const attempts: string[] = [];
  const orderIds: string[] = [];
  await db.shopper.createMany({ data: [buyer, other].map(({ id }) => ({ id, name: "After-sales test", email: `${id}@example.invalid` })) });
  t.after(async () => {
    await db.$transaction(async tx => {
      const orders = { in: orderIds };
      const cases = await tx.orderCase.findMany({ where: { orderId: orders }, select: { id: true } });
      await tx.auditEvent.deleteMany({ where: { target: { in: [...orderIds, ...cases.map(c => c.id)] } } });
      await tx.orderCase.deleteMany({ where: { orderId: orders } });
      await tx.fulfillmentEvent.deleteMany({ where: { orderId: orders } });
      await tx.payment.deleteMany({ where: { orderId: orders } });
      await tx.orderItem.deleteMany({ where: { orderId: orders } });
      await tx.order.deleteMany({ where: { id: orders } });
      await tx.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } });
      await tx.inventory.update({ where: { variantId }, data: { available: originalStock } });
      await tx.inventory.update({ where: { variantId: replacementId }, data: { available: replacementStock } });
      await tx.shopper.deleteMany({ where: { id: { in: [buyer.id, other.id] } } });
    });
  });

  async function checkout(quantity: number) {
    const guestKey = randomBytes(32).toString("hex");
    const input: CheckoutDetails = { marketId: "bd", items: [{ variantId, quantity }],
      customer: { name: "After-sales test", phone: "01700000000", district: "dhaka", locality: "Dhanmondi", address: "Fixture road 12" },
      deliveryMethod: "standard", paymentMethod: "COD" };
    const quote = await reviewCheckout(input, "bd", guestKey);
    assert.equal(quote.kind, "review");
    attempts.push(quote.attemptId);
    const result = await submitCheckout({ ...input, attemptId: quote.attemptId, reviewToken: quote.quote.reviewToken }, "bd", guestKey, buyer.id);
    assert.equal(result.kind, "placed");
    orderIds.push(result.orderId);
    return result.orderId;
  }

  const detail = (orderId: string, caseId: string) => buyerOrderCase(buyer.id, orderId, caseId, "bd");
  const progress = (caseId: string, revision: number, status: "IN_REVIEW" | "RETURN_APPROVED" | "RESOLVED") =>
    executeOrderCase(owner, { action: "review", caseId, revision, status, note: "Fixture support update." });
  const cancel = (orderId: string) => ({ action: "open", orderId, kind: "CANCEL", note: "Cancel this synthetic Bangladesh order." }) as const;
  const payment = (orderId: string) => db.payment.findUniqueOrThrow({ where: { orderId } });

  const unpaid = await checkout(1);
  await assert.rejects(executeOrderCase(other, cancel(unpaid)), { status: 404 });
  const immediate = await Promise.all([executeOrderCase(buyer, cancel(unpaid)), executeOrderCase(buyer, cancel(unpaid))]);
  assert.equal(immediate[0].id, immediate[1].id);
  assert.equal((await detail(unpaid, immediate[0].id))?.status, "RESOLVED");
  assert.equal((await payment(unpaid)).status, "VOIDED");
  assert.equal(await stock(variantId), originalStock);
  assert.equal(await db.auditEvent.count({ where: { target: unpaid, action: "ORDER_CANCELLED" } }), 1);

  const prepaid = await checkout(1);
  // Set up already-verified payment evidence locally. No gateway or wallet is contacted.
  const { amountMinor } = await db.payment.update({ where: { orderId: prepaid }, data: { method: "BKASH", status: "PAID" } });
  await advanceFulfillment(owner.id, prepaid, { next: "PACKING" });
  await advanceFulfillment(owner.id, prepaid, { next: "READY_TO_SHIP" });
  const cancelCase = await executeOrderCase(buyer, cancel(prepaid));
  await assert.rejects(advanceFulfillment(owner.id, prepaid, { next: "SHIPPED", carrier: "Fixture carrier", trackingReference: suffix }), /cancellation request/);
  await executeOrderCase(owner, { action: "approve-cancellation", caseId: cancelCase.id, revision: 0, note: "Test cancellation approved." });
  assert.equal((await payment(prepaid)).status, "REFUND_PENDING");
  assert.equal((await detail(prepaid, cancelCase.id))?.refundAmountMinor, amountMinor);
  assert.equal((await detail(prepaid, cancelCase.id))?.refundConfirmedAt, null);
  await executeOrderCase(owner, { action: "fail-refund", caseId: cancelCase.id, revision: 1, note: "The fixture payout requires a retry." });
  assert.equal((await detail(prepaid, cancelCase.id))?.status, "REFUND_FAILED");
  assert.equal((await payment(prepaid)).status, "REFUND_PENDING");
  await executeOrderCase(owner, { action: "approve-refund", caseId: cancelCase.id, revision: 2, amountMinor, note: "Retry the approved fixture refund." });
  const confirm = { action: "confirm-refund", caseId: cancelCase.id, revision: 3, amountMinor, method: "bKash",
    reference: `fixture-${suffix}`, confirmed: true } as const;
  await assert.rejects(executeOrderCase(owner, { ...confirm, amountMinor: amountMinor - 1 }), { status: 409 });
  await Promise.all([executeOrderCase(owner, confirm), executeOrderCase(owner, confirm)]);
  assert.equal((await payment(prepaid)).status, "REFUNDED");
  assert.equal(await stock(variantId), originalStock);
  assert.ok((await detail(prepaid, cancelCase.id))?.refundConfirmedAt);
  assert.equal(await db.auditEvent.count({ where: { target: cancelCase.id, action: "BD_CASE_REFUND_CONFIRMED" } }), 1);

  const delivered = await checkout(2);
  await advanceFulfillment(owner.id, delivered, { next: "PACKING" });
  await advanceFulfillment(owner.id, delivered, { next: "READY_TO_SHIP" });
  await advanceFulfillment(owner.id, delivered, { next: "SHIPPED", carrier: "Fixture carrier", trackingReference: suffix });
  await assert.rejects(executeOrderCase(buyer, cancel(delivered)), { status: 409 });
  await advanceFulfillment(owner.id, delivered, { next: "DELIVERED" });
  await collectCash(owner.id, delivered);
  const orderItem = await db.orderItem.findFirstOrThrow({ where: { orderId: delivered } });
  const request = { action: "open", orderId: delivered, note: "The synthetic size needs to be exchanged." } as const;
  const exchange = { ...request, kind: "EXCHANGE", lines: [{ orderItemId: orderItem.id, quantity: 1, replacementVariantId: replacementId }] } as const;
  const choices = await exchangeVariantsForPurchase(delivered, buyer.id, [orderItem.id]);
  assert.ok(choices.get(orderItem.id)?.some(choice => choice.id === replacementId));
  assert.ok(!choices.get(orderItem.id)?.some(choice => choice.id === "v-tee-charcoal-l"));
  assert.equal((await exchangeVariantsForPurchase(delivered, other.id, [orderItem.id])).size, 0);
  const exchangeCase = await executeOrderCase(buyer, { ...exchange, lines: [...exchange.lines] });
  const requestReturn = { ...request, kind: "RETURN", lines: [{ orderItemId: orderItem.id, quantity: 1 }] } as const;
  await assert.rejects(executeOrderCase(buyer, { ...requestReturn, lines: [...requestReturn.lines] }), { status: 409 });
  const dispatch = { action: "ship-exchange", caseId: exchangeCase.id, revision: 3, carrier: "Fixture courier", trackingReference: suffix,
    note: "Replacement handed to the fixture courier." } as const;
  await assert.rejects(executeOrderCase(owner, { ...dispatch, revision: 0 }), { status: 409 });
  await progress(exchangeCase.id, 0, "IN_REVIEW");
  await progress(exchangeCase.id, 1, "RETURN_APPROVED");
  await executeOrderCase(owner, { action: "receive", caseId: exchangeCase.id, revision: 2, disposition: "RESTOCK", confirmed: true });
  await db.inventory.update({ where: { variantId: replacementId }, data: { available: 0 } });
  await assert.rejects(executeOrderCase(owner, dispatch), { status: 409 });
  assert.equal((await detail(delivered, exchangeCase.id))?.status, "RETURN_RECEIVED");
  await db.inventory.update({ where: { variantId: replacementId }, data: { available: replacementStock } });
  await Promise.all([executeOrderCase(owner, dispatch), executeOrderCase(owner, dispatch)]);
  assert.equal(await stock(variantId), originalStock - 1);
  assert.equal(await stock(replacementId), replacementStock - 1);
  assert.equal((await detail(delivered, exchangeCase.id))?.replacementTrackingReference, suffix);
  await progress(exchangeCase.id, 4, "RESOLVED");
  assert.deepEqual((await returnItemsForPurchase(delivered, buyer.id)).map(item => item.quantity), [1]);

  const returnCase = await executeOrderCase(buyer, { ...requestReturn, lines: [...requestReturn.lines] });
  await progress(returnCase.id, 0, "IN_REVIEW");
  await progress(returnCase.id, 1, "RETURN_APPROVED");
  await executeOrderCase(owner, { action: "receive", caseId: returnCase.id, revision: 2, disposition: "HOLD", confirmed: true });
  const cap = (await staffOrderCase(owner.id, returnCase.id, "bd"))?.maxRefundMinor;
  assert.ok(cap && cap > 0);
  const approve = { action: "approve-refund", caseId: returnCase.id, revision: 3, amountMinor: cap, note: "Approve the returned fixture item." } as const;
  await assert.rejects(executeOrderCase(owner, { ...approve, amountMinor: cap + 1 }), { status: 409 });
  await executeOrderCase(owner, approve);
  assert.equal((await detail(delivered, returnCase.id))?.status, "REFUND_APPROVED");
  await executeOrderCase(owner, { ...confirm, caseId: returnCase.id, revision: 4, amountMinor: cap });
  assert.equal((await detail(delivered, returnCase.id))?.status, "RESOLVED");
  assert.ok((await detail(delivered, returnCase.id))?.refundConfirmedAt);
  assert.equal((await payment(delivered)).status, "COLLECTED");
  assert.deepEqual(await returnItemsForPurchase(delivered, buyer.id), []);
});
