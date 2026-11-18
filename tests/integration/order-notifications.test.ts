import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import "../../scripts/load-env.ts";
import { newGuestToken, readGuestKey } from "../../src/lib/commerce/guest.ts";
import { redeemGuestOrderLink } from "../../src/lib/commerce/order-recovery.ts";
import { nativeCheckoutInput } from "../../src/lib/commerce/checkout-types.ts";
import { canonicalOrder, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { shopperMailPreview } from "../../src/lib/commerce/shopper-mail.ts";
import { confirmBangladeshRecovery, startBangladeshRecovery } from "../../src/lib/marketplace/bd-order-hub.ts";
import { executeOrderCase, staffOrderCase } from "../../src/lib/marketplace/cases.ts";
import { markShopOrderNotificationsRead, readNoticeCursor, shopOrderNotifications } from "../../src/lib/marketplace/order-notification-inbox.ts";
import { advanceFulfillment, collectCash, recordBangladeshTracking } from "../../src/lib/staff/operations.ts";

const preview = process.env.COMMERCE_MODE === "local" && shopperMailPreview();

test("committed order, shipment and refund milestones reach verified owners without duplicates", {
  skip: !preview && "Requires loopback hybrid DB and SHOPPER_MAIL_MODE=preview",
}, async t => {
  const db = getDb();
  const variantId = "v-tote-oat";
  const packer = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "PACKER" }, select: { userId: true } });
  const owner = await db.staffAccess.findFirstOrThrow({
    where: { active: true, role: "OWNER", marketIds: { has: "bd" } }, select: { userId: true },
  });
  const suffix = randomUUID();
  const buyer = { id: `inbox-${suffix}`, role: "shopper", market: "bd" } as const;
  const stranger = { ...buyer, id: `inbox-other-${suffix}` };
  const staff = { id: owner.userId, role: "owner", market: "bd" } as const;
  const guestKey = readGuestKey(newGuestToken());
  assert(guestKey);
  const details = {
    marketId: "bd", items: [{ variantId, quantity: 1 }],
    customer: { name: "Synthetic Mail Test", email: `guest-${suffix}@example.invalid`, phone: "01700000000", district: "dhaka",
      locality: "Test locality", address: "Synthetic address" },
    paymentMethod: "COD", deliveryMethod: "standard",
  };
  const withoutEmail = nativeCheckoutInput.parse({ ...details, customer: { ...details.customer, email: undefined } });
  assert.equal(canonicalOrder(withoutEmail).customer.email, null);
  const reviewed = await reviewCheckout(details, "bd", guestKey);
  assert.equal(reviewed.kind, "review");
  const { attemptId } = reviewed;
  t.after(async () => {
    try {
      await db.$transaction(async tx => {
        const saved = (await tx.order.findUnique({ where: { attemptId }, select: { id: true } }))?.id;
        await tx.shopperMailRecord.deleteMany({ where: { kind: "order-recovery", recipient: details.customer.email } });
        if (saved) {
          await tx.shopperMailRecord.deleteMany({ where: { deliveryKey: { startsWith: `order-${saved}-` } } });
          await tx.bangladeshShipmentEvent.deleteMany({ where: { orderId: saved } });
          await tx.bangladeshShipment.deleteMany({ where: { orderId: saved } });
          const cases = await tx.orderCase.findMany({ where: { orderId: saved }, select: { id: true } });
          await tx.auditEvent.deleteMany({ where: { target: { in: [saved, ...cases.map(item => item.id)] } } });
          await tx.orderCase.deleteMany({ where: { orderId: saved } });
          await tx.fulfillmentEvent.deleteMany({ where: { orderId: saved } });
          await tx.payment.deleteMany({ where: { orderId: saved } });
          await tx.orderItem.deleteMany({ where: { orderId: saved } });
          await tx.order.delete({ where: { id: saved } });
          await tx.inventory.update({ where: { variantId }, data: { available: { increment: 1 } } });
        }
        await tx.checkoutAttempt.delete({ where: { id: attemptId } });
        await tx.shopper.deleteMany({ where: { id: { in: [buyer.id, stranger.id] } } });
      });
    } finally {
      await db.$disconnect();
    }
  });
  await db.shopper.createMany({ data: [buyer, stranger].map(({ id }) => ({ id, name: "Inbox Test", email: `${id}@example.invalid` })) });

  const payload = { ...details, attemptId, reviewToken: reviewed.quote.reviewToken };
  const [first, replay] = await Promise.all([submitCheckout(payload, "bd", guestKey), submitCheckout(payload, "bd", guestKey)]);
  assert.equal(first.kind, "placed");
  const orderId = first.orderId;
  assert.deepEqual(replay, first);
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { reference: true } });
  const prefix = `order-${orderId}-`;
  const messages = () => db.shopperMailRecord.findMany({ where: { deliveryKey: { startsWith: prefix } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual((await messages()).map(row => row.kind), ["order-confirmation"]);

  await advanceFulfillment(packer.userId, orderId, { next: "PACKING" });
  await advanceFulfillment(packer.userId, orderId, { next: "READY_TO_SHIP" });
  assert.equal((await messages()).length, 1);
  await advanceFulfillment(packer.userId, orderId, { next: "SHIPPED", simulate: true });
  await recordBangladeshTracking(packer.userId, orderId, { status: "OUT_FOR_DELIVERY" });
  await Promise.all([
    recordBangladeshTracking(packer.userId, orderId, { status: "DELIVERED" }),
    recordBangladeshTracking(packer.userId, orderId, { status: "DELIVERED" }),
  ]);

  const rows = await messages();
  assert.deepEqual(new Set(rows.map(row => row.deliveryKey)), new Set(["received", "shipped", "out-for-delivery", "delivered"].map(event => prefix + event)));
  assert.deepEqual(rows.map(row => row.kind), ["order-confirmation", "shipment-update", "shipment-update", "shipment-update"]);
  for (const message of rows) {
    assert.equal(message.status, "CAPTURED");
    assert.equal(message.recipient, details.customer.email);
    assert(message.subject?.includes(order.reference));
    assert(message.text);
    assert.doesNotMatch(message.text, /Synthetic address|Demo street address|\+8801700000000|@example\.invalid/);
    const rawLink = message.text.match(/https?:\/\/[^\s]+/)?.[0];
    assert(rawLink);
    const link = new URL(rawLink);
    assert.equal(link.origin, new URL(process.env.BETTER_AUTH_URL!).origin);
    assert.equal(link.pathname, `/bd/orders/recover/${orderId}`);
    assert.equal(link.search, "");
    const token = new URLSearchParams(link.hash.slice(1)).get("access");
    assert(token);
    assert.equal((await redeemGuestOrderLink(orderId, token))?.cookiePath, `/bd/orders/${orderId}`);
  }

  const notices = (shopperId: string) => shopOrderNotifications(shopperId, { orderId, filter: "all" });
  assert.deepEqual((await notices(buyer.id)).notices, []);
  const challenge = randomUUID();
  const recovery = { kind: "order", reference: order.reference, email: details.customer.email } as const;
  await startBangladeshRecovery(challenge, buyer.id, recovery, "en");
  const recoveryMail = await db.shopperMailRecord.findFirstOrThrow({ where: { kind: "order-recovery", recipient: recovery.email } });
  const code = recoveryMail.text?.match(/Recovery code: (\d{6})/)?.[1];
  assert.ok(code);
  assert.equal(await confirmBangladeshRecovery(buyer.id, { ...recovery, challenge, code }), true);
  await collectCash(staff.id, orderId);

  const lifecycle = (await notices(buyer.id)).notices;
  assert.equal(lifecycle.length, 7);
  assert.deepEqual(new Set(lifecycle.map(row => row.status)), new Set([
    "PLACED", "PACKING", "READY_TO_SHIP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "CASH_COLLECTED",
  ]));
  assert.ok(lifecycle.every(row => row.reference === order.reference && !row.read));
  assert.deepEqual((await notices(stranger.id)).notices, []);
  assert.deepEqual((await shopOrderNotifications(buyer.id, { orderId: randomUUID(), filter: "all" })).notices, []);
  const deliveredKey = lifecycle.find(row => row.status === "DELIVERED")?.key;
  assert.ok(deliveredKey);
  await markShopOrderNotificationsRead(stranger.id, [deliveredKey]);
  assert.equal(await db.shopperOrderNotificationRead.count({ where: { shopperId: stranger.id } }), 0);
  await Promise.all([
    markShopOrderNotificationsRead(buyer.id, [deliveredKey, deliveredKey]),
    markShopOrderNotificationsRead(buyer.id, [deliveredKey]),
  ]);
  assert.deepEqual((await notices(buyer.id)).notices.filter(row => row.read).map(row => row.key), [deliveredKey]);
  const firstNotice = lifecycle[0];
  const before = readNoticeCursor(`${firstNotice.at.toISOString()}~${firstNotice.key}`);
  assert.ok(before);
  assert.deepEqual((await shopOrderNotifications(buyer.id, { filter: "all", orderId, before })).notices.map(row => row.key),
    lifecycle.slice(1).map(row => row.key));

  const line = await db.orderItem.findFirstOrThrow({ where: { orderId } });
  const returnCase = await executeOrderCase(buyer, { action: "open", kind: "RETURN", orderId, lines: [{ orderItemId: line.id, quantity: 1 }],
    note: "Test case update with details kept in the case history." });
  const caseId = returnCase.id;
  await executeOrderCase(staff, { action: "review", caseId, revision: 0, status: "IN_REVIEW", note: "Review synthetic return." });
  await executeOrderCase(staff, { action: "respond", caseId, revision: 1, note: "Reply stays in case history." });
  await executeOrderCase(staff, { action: "review", caseId, revision: 2, status: "RETURN_APPROVED", note: "Approve synthetic return." });
  await executeOrderCase(staff, { action: "receive", caseId, revision: 3, disposition: "HOLD", confirmed: true });
  const amountMinor = (await staffOrderCase(staff.id, caseId, "bd"))?.maxRefundMinor;
  assert.ok(amountMinor);
  await executeOrderCase(staff, { action: "approve-refund", caseId, revision: 4, amountMinor, note: "Approve test refund." });
  await executeOrderCase(staff, { action: "fail-refund", caseId, revision: 5, note: "Synthetic payout failed." });
  await executeOrderCase(staff, { action: "approve-refund", caseId, revision: 6, amountMinor, note: "Approve test retry." });
  await executeOrderCase(staff, { action: "confirm-refund", caseId, revision: 7, amountMinor, method: "fixture",
    reference: suffix, confirmed: true });
  const afterSales = (await notices(buyer.id)).notices;
  assert.equal(afterSales.filter(row => row.caseId === caseId && row.status === "IN_REVIEW").length, 1);
  const refunds = (await shopOrderNotifications(buyer.id, { orderId, filter: "refunds" })).notices;
  assert.deepEqual(refunds.map(row => row.status), ["REFUND_CONFIRMED", "REFUND_APPROVED", "REFUND_FAILED", "REFUND_APPROVED"]);
  assert.ok(refunds.every(row => row.caseId === caseId && row.type === "refund" && !row.read));
  assert.doesNotMatch(JSON.stringify(refunds), /Synthetic payout failed|@example\.invalid/);
});
