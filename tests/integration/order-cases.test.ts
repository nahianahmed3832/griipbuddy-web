import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { buyerOrderCase, executeOrderCase, listOrderCases, returnItemsForPurchase, staffOrderCase } from "../../src/lib/marketplace/cases.ts";
import { advanceFulfillment, collectCash } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
const db = getDb();
after(() => db.$disconnect());

test("private order cases restore only physically received items once and leave COD payment unchanged", async () => {
  const suffix = randomUUID();
  const buyerId = `buyer-${suffix}`;
  const otherId = `other-${suffix}`;
  const variantId = "v-tote-oat";
  const guestKey = randomBytes(32).toString("hex");
  const buyer = { id: buyerId, role: "shopper" } as const;
  const other = { id: otherId, role: "shopper" } as const;
  const [ownerAccess, packerAccess] = await Promise.all([
    db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } }),
    db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true } }),
  ]);
  const owner = { id: ownerAccess.userId, role: "owner" } as const;
  await db.shopper.createMany({ data: [
    { id: buyerId, email: `${buyerId}@example.test`, name: "Case Shopper" },
    { id: otherId, email: `${otherId}@example.test`, name: "Other Shopper" },
  ] });
  const checkout: CheckoutDetails = {
    marketId: "bd", items: [{ variantId, quantity: 2 }],
    customer: { name: "Case Shopper", phone: "01700000000", district: "dhaka", locality: "Dhanmondi", address: "Test delivery address" },
    deliveryMethod: "standard", paymentMethod: "COD",
  };
  let attemptId: string | undefined;
  let orderId: string | undefined;
  const originalStock = (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
  try {
    const quote = await reviewCheckout(checkout, "bd", guestKey);
    assert.equal(quote.kind, "review");
    attemptId = quote.attemptId;
    const placed = await submitCheckout({ ...checkout, attemptId, reviewToken: quote.quote.reviewToken }, "bd", guestKey, buyerId);
    assert.equal(placed.kind, "placed");
    orderId = placed.orderId;
    const base = { action: "open", orderId, note: "The delivered item does not match the description." } as const;
    const orderItem = await db.orderItem.findFirstOrThrow({ where: { orderId, variantId } });
    const openReturn = { ...base, kind: "RETURN" as const, lines: [{ orderItemId: orderItem.id, quantity: 1 }] };
    await assert.rejects(executeOrderCase(buyer, openReturn), { status: 409 });
    await assert.rejects(executeOrderCase(other, { ...base, kind: "DISPUTE" }), { status: 404 });
    const dispute = await executeOrderCase(buyer, { ...base, kind: "DISPUTE", note: "I need help checking the delivery window." });
    assert.equal(await buyerOrderCase(otherId, orderId, dispute.id), null);
    await assert.rejects(executeOrderCase(other, { action: "withdraw", caseId: dispute.id, revision: 0 }), { status: 404 });
    await executeOrderCase(buyer, { action: "withdraw", caseId: dispute.id, revision: 0 });
    assert.equal((await buyerOrderCase(buyerId, orderId, dispute.id))?.status, "WITHDRAWN");

    await advanceFulfillment(packerAccess.userId, orderId, { next: "PACKING" });
    await advanceFulfillment(packerAccess.userId, orderId, { next: "READY_TO_SHIP" });
    await advanceFulfillment(packerAccess.userId, orderId, { next: "SHIPPED", carrier: "Test courier", trackingReference: suffix });
    await advanceFulfillment(packerAccess.userId, orderId, { next: "DELIVERED" });
    await collectCash(owner.id, orderId);
    const originalUnits = (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
    const originalPayment = await db.payment.findUniqueOrThrow({ where: { orderId } });
    assert.equal(originalUnits, originalStock - 2);
    assert.equal(originalPayment.status, "COLLECTED");
    await assert.rejects(executeOrderCase(buyer, { ...base, kind: "RETURN" }), { status: 400 });
    await assert.rejects(executeOrderCase(buyer, { ...openReturn, lines: [{ orderItemId: randomUUID(), quantity: 1 }] }), { status: 409 });
    const opened = await Promise.allSettled([executeOrderCase(buyer, openReturn), executeOrderCase(buyer, openReturn)]);
    const successes = opened.filter(result => result.status === "fulfilled");
    const failures = opened.filter(result => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].reason.status, 409);
    const caseId = successes[0].value.id;
    assert.ok((await listOrderCases(owner.id, false, 1)).rows.some(row => row.id === caseId));
    const receive = { action: "receive", caseId, revision: 2, disposition: "RESTOCK", confirmed: true } as const;
    await assert.rejects(executeOrderCase(owner, { ...receive, revision: 0 }), { status: 409 });

    const review = { action: "review", caseId, revision: 0, status: "IN_REVIEW", note: "We are reviewing your request." } as const;
    await assert.rejects(staffOrderCase(packerAccess.userId, caseId), /permission/);
    await assert.rejects(executeOrderCase({ id: packerAccess.userId, role: "owner" }, review), /permission/);
    await assert.rejects(executeOrderCase(owner, { ...review, status: "RETURN_APPROVED" }), { status: 409 });
    await executeOrderCase(owner, review);
    await assert.rejects(executeOrderCase(buyer, { action: "withdraw", caseId, revision: 0 }), { status: 409 });
    await executeOrderCase(owner, { ...review, revision: 1, status: "RETURN_APPROVED", note: "Bring the item to the pickup desk." });
    await assert.rejects(executeOrderCase(buyer, { action: "withdraw", caseId, revision: 2 }), { status: 409 });
    assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, originalUnits);
    await assert.rejects(executeOrderCase(owner, { ...review, revision: 2, status: "RESOLVED" }), { status: 409 });
    assert.throws(() => executeOrderCase(buyer, receive), { status: 403 });
    await assert.rejects(executeOrderCase({ id: packerAccess.userId, role: "owner" }, receive), /permission/);
    const receipts = await Promise.allSettled([executeOrderCase(owner, receive), executeOrderCase(owner, receive)]);
    assert.equal(receipts.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(receipts.filter(r => r.status === "rejected")[0].reason.status, 409);
    assert.equal((await staffOrderCase(owner.id, caseId))?.returnDisposition, "RESTOCK");
    assert.equal(await db.auditEvent.count({ where: { target: caseId, action: "BD_RETURN_CASE_RECEIVED" } }), 1);
    await executeOrderCase(owner, { ...review, revision: 3, status: "RESOLVED", note: "The return is complete." });

    const visibleCase = await buyerOrderCase(buyerId, orderId, caseId);
    assert.equal(visibleCase?.status, "RESOLVED");
    assert.deepEqual(visibleCase?.events.map(event => event.status), ["OPEN", "IN_REVIEW", "RETURN_APPROVED", "RETURN_RECEIVED", "RESOLVED"]);
    assert.equal(visibleCase?.returnLines[0].quantity, 1);
    assert.equal(visibleCase?.events[2].note, "Bring the item to the pickup desk.");
    assert.equal((await listOrderCases(owner.id, false, 1)).rows.some(row => row.id === caseId), false);
    assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, originalUnits + 1);
    assert.deepEqual(await db.payment.findUniqueOrThrow({ where: { orderId } }), originalPayment);
    assert.deepEqual((await returnItemsForPurchase(orderId, buyerId)).map(item => item.quantity), [1]);
    await assert.rejects(executeOrderCase(buyer, { ...openReturn, lines: [{ orderItemId: orderItem.id, quantity: 2 }] }), { status: 409 });

    await db.orderCase.create({ data: { orderId, kind: "RETURN", status: "RESOLVED" } });
    assert.deepEqual(await returnItemsForPurchase(orderId, buyerId), []);
    await assert.rejects(executeOrderCase(buyer, openReturn), { status: 409, message: /previous return/ });
  } finally {
    await db.$transaction(async tx => {
      if (orderId) {
        await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
        await tx.payment.deleteMany({ where: { orderId } });
        const cases = await tx.orderCase.findMany({ where: { orderId }, select: { id: true } });
        await tx.auditEvent.deleteMany({ where: { target: { in: [orderId, ...cases.map(orderCase => orderCase.id)] } } });
        await tx.orderCase.deleteMany({ where: { orderId } });
        await tx.orderItem.deleteMany({ where: { orderId } });
        await tx.order.delete({ where: { id: orderId } });
        await tx.inventory.update({ where: { variantId }, data: { available: originalStock } });
      }
      if (attemptId) await tx.checkoutAttempt.delete({ where: { id: attemptId } });
      await tx.shopper.deleteMany({ where: { id: { in: [buyerId, otherId] } } });
    });
  }
});
