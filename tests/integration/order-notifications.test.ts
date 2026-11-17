import assert from "node:assert/strict";
import { test } from "node:test";
import "../../scripts/load-env.ts";
import { newGuestToken, readGuestKey } from "../../src/lib/commerce/guest.ts";
import { redeemGuestOrderLink } from "../../src/lib/commerce/order-recovery.ts";
import { nativeCheckoutInput } from "../../src/lib/commerce/checkout-types.ts";
import { canonicalOrder, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { shopperMailPreview } from "../../src/lib/commerce/shopper-mail.ts";
import { advanceFulfillment, recordBangladeshTracking } from "../../src/lib/staff/operations.ts";

const preview = process.env.COMMERCE_MODE === "local" && shopperMailPreview();

test("committed order and shipment effects capture one private test email per milestone", {
  skip: !preview && "Requires loopback hybrid DB and SHOPPER_MAIL_MODE=preview",
}, async t => {
  const db = getDb();
  const variantId = "v-tote-oat";
  const packer = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "PACKER" }, select: { userId: true } });
  const guestKey = readGuestKey(newGuestToken());
  assert(guestKey);
  const details = {
    marketId: "bd", items: [{ variantId, quantity: 1 }],
    customer: { name: "Synthetic Mail Test", email: "guest-preview@example.invalid", phone: "01700000000", district: "dhaka",
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
        if (saved) {
          await tx.shopperMailRecord.deleteMany({ where: { deliveryKey: { startsWith: `order-${saved}-` } } });
          await tx.bangladeshShipmentEvent.deleteMany({ where: { orderId: saved } });
          await tx.bangladeshShipment.deleteMany({ where: { orderId: saved } });
          await tx.auditEvent.deleteMany({ where: { target: saved } });
          await tx.fulfillmentEvent.deleteMany({ where: { orderId: saved } });
          await tx.payment.deleteMany({ where: { orderId: saved } });
          await tx.orderItem.deleteMany({ where: { orderId: saved } });
          await tx.order.delete({ where: { id: saved } });
          await tx.inventory.update({ where: { variantId }, data: { available: { increment: 1 } } });
        }
        await tx.checkoutAttempt.delete({ where: { id: attemptId } });
      });
    } finally {
      await db.$disconnect();
    }
  });

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
});
