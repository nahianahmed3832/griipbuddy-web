import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { createGuestOrderLink, recoveredReceiptGuestKey, redeemGuestOrderLink } from "../../src/lib/commerce/order-recovery.ts";
import { guestOrder } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { cashDueOnDelivery } from "../../src/lib/commerce/account-order.ts";
import { latestShopperOrder, shopperOrders } from "../../src/lib/marketplace/data.ts";
import { claimGuestOrder, matchesVerifiedCheckoutContact } from "../../src/lib/marketplace/order-claim.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("private order recovery stays scoped to one unclaimed order", async () => {
  const guestKey = randomBytes(32).toString("hex");
  const shopperId = randomUUID();
  const [first, second] = await db.$transaction(["bd", "us"].map(country => {
    const marketId = country === "bd" ? "bd" : "us";
    const currency = marketId === "bd" ? "BDT" : "USD";
    const id = randomUUID();
    return db.order.create({ data: {
      id, reference: `RECOVERY-${id}`, marketId, currency,
      attempt: { create: { id: randomUUID(), guestKey, requestHash: randomBytes(32).toString("hex") } },
      customerName: "Synthetic Tracking Customer", phone: "+8801710000000", district: "dhaka", districtLabel: "Dhaka",
      locality: "Test locality", address: "Synthetic address", deliveryMethod: "standard", deliveryLabel: "Standard delivery",
      taxLabel: "Test tax", subtotalMinor: 1000, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor: 1000,
    }, select: { id: true, attemptId: true } });
  }));

  try {
    assert.equal(await createGuestOrderLink(first.id, randomBytes(32).toString("hex")), null);
    assert.equal(await createGuestOrderLink(first.id, guestKey, "us"), null);
    const link = await createGuestOrderLink(first.id, guestKey);
    assert.ok(link);
    const token = new URLSearchParams(link.path.split("#")[1]).get("access");
    assert.ok(token);
    assert.equal(await redeemGuestOrderLink(second.id, token), null);
    assert.equal(await redeemGuestOrderLink(first.id, token, "us"), null);
    assert.equal(await recoveredReceiptGuestKey(first.id, token), null);

    const access = await redeemGuestOrderLink(first.id, token);
    assert.ok(access);
    assert.equal(access.maxAge, 86_400);
    assert.equal(await recoveredReceiptGuestKey(first.id, access.cookie), guestKey);
    assert.equal(await recoveredReceiptGuestKey(second.id, access.cookie), null);
    assert.equal(await redeemGuestOrderLink(first.id, access.cookie), null);

    await db.shopper.create({ data: { id: shopperId, name: "Recovery fixture", email: `${shopperId}@example.test` } });
    await db.order.update({ where: { id: first.id }, data: { shopperId } });
    assert.equal(await createGuestOrderLink(first.id, guestKey), null);
    assert.equal(await redeemGuestOrderLink(first.id, token), null);
    assert.equal(await recoveredReceiptGuestKey(first.id, access.cookie), null);
    assert.equal(await guestOrder(first.id, guestKey), null);
    assert.equal((await guestOrder(first.id, null, shopperId))?.id, first.id);
  } finally {
    await db.$transaction([
      db.order.deleteMany({ where: { id: { in: [first.id, second.id] } } }),
      db.checkoutAttempt.deleteMany({ where: { id: { in: [first.attemptId, second.attemptId] } } }),
      db.shopper.deleteMany({ where: { id: shopperId } }),
    ]);
  }
});

test("a verified shopper can claim a matching order once with order proof and market scope", async () => {
  const [shopperId, otherId, id, attemptId] = Array.from({ length: 4 }, () => randomUUID());
  const email = `${shopperId}@example.invalid`;
  const guestKey = randomBytes(32).toString("hex");
  await db.shopper.createMany({ data: [
    { id: shopperId, name: "Claim fixture", email },
    { id: otherId, name: "Other fixture", email: `${otherId}@example.invalid`, emailVerified: true },
  ] });
  await db.order.create({ data: {
    id, reference: `CLAIM-${id}`, marketId: "bd", currency: "BDT",
    attempt: { create: { id: attemptId, guestKey, requestHash: randomBytes(32).toString("hex") } },
    customerName: "Guest fixture", email: email.toUpperCase(), phone: "+8801700000000", district: "dhaka", districtLabel: "Dhaka",
    locality: "Test locality", address: "Address snapshot", deliveryMethod: "standard", deliveryLabel: "Standard delivery",
    taxLabel: "Test tax", subtotalMinor: 2800, discountMinor: 0, deliveryMinor: 200, taxMinor: 0, totalMinor: 3000,
    payment: { create: { method: "COD", status: "AWAITING_COLLECTION", currency: "BDT", amountMinor: 2200 } },
  } });
  try {
    const claim = { orderId: id, shopperId, marketId: "bd" as const };
    const link = await createGuestOrderLink(id, guestKey, "bd");
    assert.ok(link);
    const token = new URLSearchParams(link.path.split("#")[1]).get("access");
    assert.ok(token);
    assert.equal(await claimGuestOrder(claim), "unavailable");
    assert.equal(await claimGuestOrder({ ...claim, marketId: "us", guestKey }), "unavailable");
    assert.equal(await claimGuestOrder({ ...claim, guestKey }), "verify-contact");
    assert.equal(await claimGuestOrder({ ...claim, guestKey, shopperId: otherId }), "verify-contact");
    assert.equal(await guestOrder(id, guestKey, undefined, "us"), null);

    await db.shopper.update({ where: { id: shopperId }, data: { emailVerified: true } });
    const results = await Promise.all([
      claimGuestOrder({ ...claim, trackingToken: token }),
      claimGuestOrder({ ...claim, guestKey }),
    ]);
    assert.deepEqual(results, ["claimed", "claimed"]);
    assert.equal(await claimGuestOrder(claim), "claimed");
    assert.equal(await claimGuestOrder({ ...claim, guestKey, shopperId: otherId }), "unavailable");
    assert.equal(await db.shopperAccountEvent.count({ where: { shopperId, marketId: "bd", action: "order_claimed" } }), 1);
    assert.equal(await redeemGuestOrderLink(id, token, "bd"), null);
    assert.deepEqual((await shopperOrders(shopperId, null, "bd")).map(order => order.id), [id]);
    assert.deepEqual(await shopperOrders(shopperId, guestKey, "us"), []);
    assert.deepEqual(await shopperOrders(otherId, guestKey, "bd"), []);

    const latest = await latestShopperOrder(shopperId, "bd");
    assert.ok(latest);
    assert.equal(latest.totalMinor, 3000);
    assert.equal(cashDueOnDelivery(latest), 2200);
    await db.payment.update({ where: { orderId: id }, data: { status: "COLLECTED" } });
    const collected = await latestShopperOrder(shopperId, "bd");
    assert.ok(collected);
    assert.equal(cashDueOnDelivery(collected), null);
    assert.equal((await guestOrder(id, null, shopperId, "bd"))?.address, "Address snapshot");
  } finally {
    await db.$transaction([
      db.payment.deleteMany({ where: { orderId: id } }),
      db.order.deleteMany({ where: { id } }),
      db.checkoutAttempt.deleteMany({ where: { id: attemptId } }),
      db.shopper.deleteMany({ where: { id: { in: [shopperId, otherId] } } }),
    ]);
  }
});

test("shared preview contacts cannot authorize an order claim", () => {
  assert.equal(matchesVerifiedCheckoutContact(
    { marketId: "bd", email: "checkout@example.invalid", phone: "01700000000" },
    { email: "checkout@example.invalid", emailVerified: true, phoneNumber: "+8801700000000", phoneNumberVerified: true },
  ), false);
  assert.equal(matchesVerifiedCheckoutContact(
    { marketId: "bd", email: null, phone: "01710000000" },
    { email: "phone@example.invalid", emailVerified: false, phoneNumber: "+8801710000000", phoneNumberVerified: true },
  ), true);
});
