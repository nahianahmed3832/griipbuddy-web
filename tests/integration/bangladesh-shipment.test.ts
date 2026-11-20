import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { receiveBangladeshRefusedParcel } from "../../src/lib/commerce/bangladesh-returns.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { guestOrder, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { advanceFulfillment, collectCash, recordBangladeshTracking } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.GRIIP_HYBRID_STOREFRONT = "1";
after(() => db.$disconnect());

test("Bangladesh tracking records delivered and refused outcomes without collecting COD or restocking", async () => {
  const variantId = "v-tote-oat";
  const stock = async () => (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
  const previousStock = await stock();
  const [owner, packer] = await Promise.all(["OWNER", "PACKER"].map(role => db.staffAccess.findFirstOrThrow({
    where: { role: role === "OWNER" ? "OWNER" : "PACKER", active: true }, select: { userId: true },
  }).then(access => access.userId)));
  const checkouts: { attemptId: string; orderId?: string }[] = [];

  async function dispatch() {
    const details: CheckoutDetails = {
      marketId: "bd", items: [{ variantId, quantity: 1 }],
      customer: { name: "Tracking Test", phone: "01700000000", district: "dhaka", locality: "Test locality", address: "Test street address" },
      paymentMethod: "COD", deliveryMethod: "standard",
    };
    const guestKey = randomBytes(32).toString("hex");
    const reviewed = await reviewCheckout(details, "bd", guestKey);
    assert.equal(reviewed.kind, "review");
    const fixture: { attemptId: string; orderId?: string } = { attemptId: reviewed.attemptId };
    checkouts.push(fixture);
    const placed = await submitCheckout({ ...details, attemptId: reviewed.attemptId, reviewToken: reviewed.quote.reviewToken }, "bd", guestKey);
    assert.equal(placed.kind, "placed");
    const orderId = fixture.orderId = placed.orderId;
    await advanceFulfillment(packer, orderId, { next: "PACKING" });
    await advanceFulfillment(packer, orderId, { next: "READY_TO_SHIP" });
    await assert.rejects(advanceFulfillment(packer, orderId, { next: "SHIPPED", simulate: true }), /only for test orders/);
    await advanceFulfillment(packer, orderId, { next: "SHIPPED", carrier: "Tracking test courier", trackingReference: randomUUID() });
    return { guestKey, orderId };
  }

  try {
    const delivered = await dispatch();
    const refused = await dispatch();
    for (const { orderId, guestKey } of [delivered, refused]) {
      assert.equal((await guestOrder(orderId, guestKey))?.bangladeshShipment?.status, "IN_TRANSIT");
      assert.equal(await guestOrder(orderId, randomBytes(32).toString("hex")), null);
      await assert.rejects(advanceFulfillment(packer, orderId, { next: "DELIVERED" }), /courier’s delivery outcome/);
      await assert.rejects(recordBangladeshTracking(packer, orderId, { status: "OUT_FOR_DELIVERY" }), /evidence|event or support reference/);
      await recordBangladeshTracking(packer, orderId, { status: "OUT_FOR_DELIVERY", evidence: "private-carrier-note" });
    }

    const deliveryUpdate = { status: "DELIVERED", evidence: "delivery-proof" };
    await Promise.all([recordBangladeshTracking(packer, delivered.orderId, deliveryUpdate), recordBangladeshTracking(packer, delivered.orderId, deliveryUpdate)]);
    const delivery = await guestOrder(delivered.orderId, delivered.guestKey);
    assert.equal(delivery?.fulfillmentStatus, "DELIVERED");
    assert.equal(delivery.payment?.status, "AWAITING_COLLECTION");
    assert.deepEqual(delivery.bangladeshShipment?.events.map(event => event.status), ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]);
    assert.doesNotMatch(JSON.stringify(delivery.bangladeshShipment), /private-carrier-note|delivery-proof|actorId/);

    const receipt = { disposition: "RESTOCK", note: "Inspected complete and sellable" };
    await assert.rejects(receiveBangladeshRefusedParcel(packer, refused.orderId, receipt));
    const refusalUpdate = { status: "REFUSED", evidence: "refusal-proof" };
    await assert.rejects(recordBangladeshTracking(packer, refused.orderId, refusalUpdate), /permission/);
    await recordBangladeshTracking(owner, refused.orderId, refusalUpdate);
    await assert.rejects(recordBangladeshTracking(owner, refused.orderId, deliveryUpdate), /no longer available/);
    await assert.rejects(collectCash(owner, refused.orderId), /after the order is delivered/);
    const refusal = await guestOrder(refused.orderId, refused.guestKey);
    assert.equal(refusal?.bangladeshShipment?.status, "REFUSED");
    assert.equal(refusal.payment?.status, "VOIDED");
    assert.equal(await stock(), previousStock - 2);
    assert.deepEqual(await Promise.all([
      receiveBangladeshRefusedParcel(packer, refused.orderId, receipt),
      receiveBangladeshRefusedParcel(owner, refused.orderId, receipt),
    ]), [{ disposition: "RESTOCK", restockedUnits: 1 }, { disposition: "RESTOCK", restockedUnits: 1 }]);
    assert.equal(await stock(), previousStock - 1);
    assert.equal(await db.auditEvent.count({ where: { target: refused.orderId, action: "BD_REFUSED_PARCEL_RECEIVED" } }), 1);
    const received = await guestOrder(refused.orderId, refused.guestKey);
    assert.ok(received?.bangladeshRefusedParcelReceipt?.receivedAt);
    assert.equal(received?.payment?.status, "VOIDED");
  } finally {
    await db.$transaction(async tx => {
      for (const { orderId, attemptId } of checkouts) {
        if (orderId) {
          const receipt = await tx.bangladeshRefusedParcelReceipt.findUnique({ where: { orderId }, select: { restockedUnits: true } });
          await tx.bangladeshRefusedParcelReceipt.deleteMany({ where: { orderId } });
          await tx.bangladeshShipmentEvent.deleteMany({ where: { orderId } });
          await tx.bangladeshShipment.deleteMany({ where: { orderId } });
          await tx.auditEvent.deleteMany({ where: { target: orderId } });
          await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
          await tx.payment.deleteMany({ where: { orderId } });
          await tx.orderItem.deleteMany({ where: { orderId } });
          await tx.order.delete({ where: { id: orderId } });
          if (!receipt?.restockedUnits) await tx.inventory.update({ where: { variantId }, data: { available: { increment: 1 } } });
        }
        await tx.checkoutAttempt.delete({ where: { id: attemptId } });
      }
    });
  }
});
