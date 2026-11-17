import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import sharp from "sharp";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { configuredManualPayments } from "../../src/lib/commerce/manual-payment-config.ts";
import { recoverCheckout, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { encodeCatalogImage } from "../../src/lib/staff/catalog-media.ts";
import {
  advanceFulfillment, listStaffOrders, reviewManualPayment, staffManualPayment, staffManualPaymentReceipt,
} from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("manual wallet checkout keeps proof private and gates fulfillment until authorized verification", async () => {
  const suffix = randomBytes(5).toString("hex");
  const guestKey = randomBytes(32).toString("hex");
  const productId = `bd-wallet-${suffix}`;
  const variantId = `v-${productId}`;
  const transactionId = `WALLET${suffix.toUpperCase()}`;
  const orderIds: string[] = [];
  const [department, zone, owner, packer] = await Promise.all([
    db.department.findFirstOrThrow(),
    db.deliveryZone.findFirstOrThrow({ where: { marketId: "bd", enabled: true, codEligible: true, chargeMinor: { not: null } } }),
    db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } }),
    db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true } }),
  ]);
  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: department.id, name: "Wallet payment test item",
    description: "Isolated checkout test fixture", keywords: [], specifications: {}, position: 18_000, addedOn: new Date(), publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId, label: "Black", position: 0, options: {},
      inventory: { create: { available: 4 } }, offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 17_500 } } } },
  } });
  const body = {
    marketId: "bd", paymentMethod: "BKASH", deliveryMethod: zone.method, items: [{ variantId, quantity: 1 }],
    customer: { district: zone.district, name: "Test shopper", phone: "01700000000", locality: "Test area", address: "Synthetic test address" },
  };
  const stock = async () => (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
  const attempt = async (paymentMethod: string) => {
    const checkout = { ...body, paymentMethod };
    const review = await reviewCheckout(checkout, "bd", guestKey);
    assert.equal(review.kind, "review");
    return { quote: review.quote, payload: { ...checkout, attemptId: review.attemptId, reviewToken: review.quote.reviewToken } };
  };
  const transaction = { kind: "transaction", payerPhone: "01700000001", transactionId: transactionId.toLowerCase() };
  const record = async (payload: object, proof: object, receipt?: Uint8Array<ArrayBuffer>) => {
    const result = await submitCheckout({ ...payload, manualProof: proof }, "bd", guestKey, undefined, receipt);
    assert.equal(result.kind, "placed");
    orderIds.push(result.orderId);
    return result;
  };
  try {
    delete process.env.BD_MANUAL_TEST_MODE;
    assert.equal(configuredManualPayments().length, 0);
    assert.equal((await reviewCheckout(body, "bd", guestKey)).kind, "unavailable");
    process.env.BD_MANUAL_TEST_MODE = "1";
    assert.deepEqual(configuredManualPayments().map(({ method, recipient }) => [method, recipient]),
      [["BKASH", "01XXXXXXXXX"], ["NAGAD", "01XXXXXXXXX"], ["ROCKET", "01XXXXXXXXXX"]]);

    const cash = await attempt("COD");
    const original = await attempt("BKASH");
    assert.equal(original.quote.totalMinor, cash.quote.totalMinor);
    assert.equal(original.quote.prepaidDiscountMinor, undefined);
    assert.equal(original.quote.manualPayment?.recipient, "01XXXXXXXXX");
    assert.equal((await submitCheckout(original.payload, "bd", guestKey)).kind, "invalid");
    assert.equal((await submitCheckout({ ...original.payload, manualProof: { kind: "receipt" } }, "bd", guestKey)).kind, "invalid");
    const order = await record(original.payload, transaction);
    assert.deepEqual(await submitCheckout({ ...original.payload, manualProof: transaction }, "bd", guestKey), order);
    assert.deepEqual(await recoverCheckout(original.payload.attemptId, guestKey), order);
    assert.equal(await stock(), 3);
    assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId: order.orderId } })).status, "AWAITING_VERIFICATION");
    assert.equal((await staffManualPayment(owner.userId, order.orderId))?.submittedTransaction, transactionId);
    assert.ok(!(await listStaffOrders(packer.userId, "queue", 1)).rows.some(row => row.id === order.orderId));
    assert.ok((await listStaffOrders(owner.userId, "payment-review", 1)).rows.some(row => row.id === order.orderId));
    await assert.rejects(listStaffOrders(packer.userId, "payment-review", 1), /permission/);
    await assert.rejects(staffManualPayment(packer.userId, order.orderId), /permission/);
    await assert.rejects(advanceFulfillment(packer.userId, order.orderId, { next: "PACKING" }), /payment is incomplete/);
    const approval = { approve: true, amountMinor: original.quote.totalMinor, transaction: transactionId };
    await assert.rejects(reviewManualPayment(packer.userId, order.orderId, approval), /permission/);
    await assert.rejects(reviewManualPayment(owner.userId, order.orderId, { ...approval, amountMinor: 20 }), /amount must match/);
    await assert.rejects(reviewManualPayment(owner.userId, order.orderId, { ...approval, transaction: "WRONG123" }), /must match the shopper/);
    await Promise.all([
      reviewManualPayment(owner.userId, order.orderId, approval),
      reviewManualPayment(owner.userId, order.orderId, approval),
    ]);
    const paid = await db.payment.findUniqueOrThrow({ where: { orderId: order.orderId } });
    assert.equal(paid.status, "PAID");
    assert.equal(paid.amountMinor, original.quote.totalMinor);
    assert.equal(paid.collectedById, owner.userId);
    assert.equal(await db.auditEvent.count({ where: { target: order.orderId, action: "MANUAL_PAYMENT_APPROVED", actorId: owner.userId } }), 1);
    await advanceFulfillment(packer.userId, order.orderId, { next: "PACKING" });

    const duplicate = await record((await attempt("BKASH")).payload, transaction);
    await assert.rejects(reviewManualPayment(owner.userId, duplicate.orderId, approval), /already verified on another order/);
    assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId: duplicate.orderId } })).status, "AWAITING_VERIFICATION");

    const sample = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
    const receipt = (await encodeCatalogImage(sample, "image/png")).data;
    const decline = await record((await attempt("NAGAD")).payload, { kind: "receipt" }, receipt);
    assert.deepEqual((await staffManualPaymentReceipt(owner.userId, decline.orderId))?.receipt, receipt);
    await assert.rejects(staffManualPaymentReceipt(packer.userId, decline.orderId), /permission/);
    assert.equal(await stock(), 1);
    const decision = { approve: false, note: "Test receipt amount does not match." };
    await Promise.all([
      reviewManualPayment(owner.userId, decline.orderId, decision),
      reviewManualPayment(owner.userId, decline.orderId, decision),
    ]);
    assert.equal(await stock(), 2);
    assert.equal((await db.order.findUniqueOrThrow({ where: { id: decline.orderId } })).status, "CANCELLED");
    assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId: decline.orderId } })).status, "VOIDED");
    assert.equal((await staffManualPayment(owner.userId, decline.orderId))?.reviewNote, decision.note);
    assert.equal(await db.auditEvent.count({ where: { target: decline.orderId, action: "MANUAL_PAYMENT_DECLINED", actorId: owner.userId } }), 1);
  } finally {
    delete process.env.BD_MANUAL_TEST_MODE;
    const inOrders = { in: orderIds };
    await db.$transaction([
      db.auditEvent.deleteMany({ where: { target: inOrders } }),
      db.fulfillmentEvent.deleteMany({ where: { orderId: inOrders } }),
      db.bangladeshManualProof.deleteMany({ where: { orderId: inOrders } }),
      db.payment.deleteMany({ where: { orderId: inOrders } }),
      db.orderItem.deleteMany({ where: { orderId: inOrders } }),
      db.order.deleteMany({ where: { id: inOrders } }),
      db.checkoutAttempt.deleteMany({ where: { guestKey } }),
      db.marketOffer.deleteMany({ where: { variantId } }),
      db.inventory.delete({ where: { variantId } }),
      db.variant.delete({ where: { id: variantId } }),
      db.product.delete({ where: { id: productId } }),
    ]);
  }
});
