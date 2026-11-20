import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import "../../scripts/load-env.ts";
import { GET as accountTracking } from "../../src/app/api/orders/[id]/tracking/route.ts";
import { GET as guestTracking } from "../../src/app/api/orders/[id]/tracking/guest/route.ts";
import { guestCookie, newGuestToken, readGuestKey } from "../../src/lib/commerce/guest.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { shopperAuth } from "../../src/lib/marketplace/auth.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
const variantId = "v-tote-oat";
after(() => db.$disconnect());

async function signIn(email: string) {
  const password = randomBytes(24).toString("hex");
  const authorize = (action: "sign-up" | "sign-in") => shopperAuth().handler(new Request(`${origin}/api/shopper-auth/${action}/email`, {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "Tracking test shopper", email, password }),
  }));
  assert.equal((await authorize("sign-up")).status, 200);
  const session = await authorize("sign-in");
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  assert.ok(cookie);
  return cookie;
}

async function fixtureOrder(guestKey: string, shopperId?: string) {
  return db.order.create({ data: {
    reference: `GB-${randomBytes(6).toString("hex").toUpperCase()}`, marketId: "bd", currency: "BDT",
    ...(shopperId && { shopper: { connect: { id: shopperId } } }),
    attempt: { create: { id: randomUUID(), guestKey, requestHash: randomBytes(32).toString("hex") } },
    customerName: "Confidential Name", phone: "01700001234", email: "customer-private@example.test", address: "123 Secret address",
    district: "dhaka", districtLabel: "Dhaka", locality: "Test neighborhood", postalCode: "1000",
    deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax", subtotalMinor: 1500, discountMinor: 0,
    deliveryMinor: 0, taxMinor: 0, totalMinor: 1500, measurementTest: true,
    items: { create: { variantId, productName: "Canvas tote", variantName: "Oat", sku: "TOTE-OAT", quantity: 3,
      unitPriceMinor: 500, unitDiscountMinor: 0, lineTotalMinor: 1500, currency: "BDT", personalization: "Private embroidery" } },
    payment: { create: { method: "COD", currency: "BDT", amountMinor: 1500 } },
  }, include: { items: true } });
}

async function removeOrders(rows: { id: string; attemptId: string }[]) {
  const orderIds = rows.map(row => row.id);
  await db.$transaction([
    db.bangladeshShipmentEvent.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.bangladeshShipment.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.orderParcel.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.payment.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.order.deleteMany({ where: { id: { in: orderIds } } }),
    db.checkoutAttempt.deleteMany({ where: { id: { in: rows.map(row => row.attemptId) } } }),
  ]);
}

async function tracking(access: "account" | "guest", id: string, cookie?: string, query = "", crossSite = false) {
  const request = new NextRequest(`${origin}/api/orders/${id}/tracking${access === "guest" ? "/guest" : ""}${query}`, {
    headers: { ...(cookie ? { cookie } : {}), ...(crossSite ? { "sec-fetch-site": "cross-site" } : {}) },
  });
  const response = await (access === "guest" ? guestTracking : accountTracking)(request, { params: Promise.resolve({ id }) });
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after") };
}

test("tracking authorizes the shopper or original unclaimed guest separately and exposes only safe split-shipment data", async t => {
  const previousPreview = process.env.GRIIP_MARKETPLACE_PREVIEW;
  process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
  t.after(() => {
    if (previousPreview === undefined) delete process.env.GRIIP_MARKETPLACE_PREVIEW;
    else process.env.GRIIP_MARKETPLACE_PREVIEW = previousPreview;
  });
  const tag = randomUUID();
  const emails = [`owner-${tag}@example.test`, `other-${tag}@example.test`];
  const ownerCookie = await signIn(emails[0]);
  const otherCookie = await signIn(emails[1]);
  const owner = await db.shopper.findUniqueOrThrow({ where: { email: emails[0] } });
  const token = newGuestToken();
  const cookie = `${guestCookie}=${token}`;
  const key = readGuestKey(token)!;
  const orders = [await fixtureOrder(key, owner.id), await fixtureOrder(key), await fixtureOrder(key), await fixtureOrder(key)];
  const [claimed, unclaimed, historical, orderLevelHandoff] = orders;
  const locationIds = [`${tag}-a`, `${tag}-b`];
  t.after(async () => {
    await removeOrders(orders);
    await db.dispatchLocation.deleteMany({ where: { id: { in: locationIds } } });
    await db.shopper.deleteMany({ where: { email: { in: emails } } });
  });
  await db.dispatchLocation.createMany({ data: locationIds.map(id => ({ id, name: "Confidential warehouse", marketId: "bd" })) });
  const occurred = new Date(Date.now() - 300_000);
  const received = new Date(Date.now() - 200_000);
  const eta = new Date(Date.now() + 86_400_000);
  const first = await db.orderParcel.create({ data: {
    orderId: claimed.id, locationId: locationIds[0], locationName: "Confidential warehouse", status: "IN_TRANSIT",
    trackingStatus: "OUT_FOR_DELIVERY", trackingOccurredAt: occurred, trackingReportedAt: received,
    trackingSyncedAt: received, estimatedDeliveryAt: eta,
    carrier: "Steadfast Courier", trackingReference: "SFT-FIXTURE-127", source: "MANUAL",
    items: { create: { orderItemId: claimed.items[0].id, quantity: 1 } },
    events: { create: [
      { status: "PLANNED", recordedAt: new Date(+occurred - 10_000) },
      { status: "IN_TRANSIT", recordedAt: new Date(+occurred - 5000), actorId: "Confidential operator", reason: "Private courier notes" },
    ] },
    trackingObservations: { create: [
      { source: "CARRIER_WEBHOOK", status: "OUT_FOR_DELIVERY", occurredAt: occurred, recordedAt: received, applied: true,
        eventKey: "confidential-carrier-event-1", providerCode: "PRIVATE_PROVIDER_CODE" },
      { source: "CARRIER_WEBHOOK", status: "IN_TRANSIT", occurredAt: new Date(+occurred - 10_000), recordedAt: new Date(+received + 1000),
        eventKey: "confidential-carrier-delayed", applied: false },
    ] },
  } });
  const second = await db.orderParcel.create({ data: {
    orderId: claimed.id, locationId: locationIds[1], locationName: "Confidential warehouse",
    status: "IN_TRANSIT", source: "MANUAL", carrier: "Other fixture courier", trackingReference: "https://example.invalid/secret",
    items: { create: { orderItemId: claimed.items[0].id, quantity: 2, cancelledQuantity: 1 } },
  } });
  await db.orderParcel.create({ data: { orderId: claimed.id, locationId: locationIds[1], locationName: "Cancelled fixture warehouse",
    cancelledAt: received } });
  await db.bangladeshShipment.create({ data: { orderId: historical.id, carrier: "Fixture courier", trackingReference: "LEGACY-123",
    status: "IN_TRANSIT", source: "MANUAL", statusUpdatedAt: occurred } });
  await db.order.update({ where: { id: orderLevelHandoff.id }, data: { carrier: "Other courier", trackingReference: "LEGACY-PACKAGE",
    fulfillmentStatus: "SHIPPED" } });

  const orderWhere = { id: { in: orders.map(row => row.id) } };
  const sideEffects = () => Promise.all([
    db.order.findMany({ where: orderWhere, orderBy: { id: "asc" } }),
    db.payment.findMany({ where: { orderId: orderWhere.id }, orderBy: { orderId: "asc" } }),
    db.codRemittance.findMany({ where: { orderId: orderWhere.id } }),
    db.inventory.findUniqueOrThrow({ where: { variantId } }),
    db.locationInventory.findMany({ where: { variantId }, orderBy: { locationId: "asc" } }),
    db.inventoryPool.findMany({ where: { variantId }, orderBy: { id: "asc" } }),
    db.inventoryReservation.findMany({ where: { orderId: orderWhere.id }, orderBy: { id: "asc" } }),
  ]);
  const before = await sideEffects();
  const response = await tracking("account", claimed.id, ownerCookie);
  assert.equal(response.status, 200);
  assert.equal(response.body.orderStatus, "PLACED");
  assert.equal(response.body.reference, claimed.reference);
  assert.equal(response.body.shipments.length, 2);
  assert.deepEqual(response.body.summary, { status: "SHIPPED", total: 2, preparing: 0, dispatched: 2, delivered: 0, exceptions: 0, returned: 0 });
  const dispatched = response.body.shipments.find((entry: { id: string }) => entry.id === first.id);
  assert.equal(dispatched.status, "OUT_FOR_DELIVERY");
  assert.equal(dispatched.estimatedDeliveryAt, eta.toISOString());
  assert.equal(dispatched.lastSyncedAt, received.toISOString());
  assert.equal(dispatched.trackingUrl, "https://www.steadfast.com.bd/tracking");
  assert.equal(dispatched.events.length, 3);
  assert.deepEqual(dispatched.events[2], { status: "OUT_FOR_DELIVERY", occurredAt: occurred.toISOString(),
    receivedAt: received.toISOString(), source: "CARRIER_WEBHOOK" });
  assert.equal(dispatched.items[0].quantity, 1);
  const pending = response.body.shipments.find((entry: { id: string }) => entry.id === second.id);
  assert.equal(pending.status, "IN_TRANSIT");
  assert.equal(pending.trackingUrl, null);
  assert.equal(pending.trackingReference, null);
  assert.equal(pending.lastSyncedAt, null);
  assert.equal(pending.items[0].quantity, 1);
  assert.doesNotMatch(JSON.stringify(response.body), /Confidential|01700001234|customer-private|Secret address|Private embroidery|secret|PROVIDER_CODE|Private courier|confidential-carrier|payment|COD|shopperId|guestKey|locationId/);

  const denied = await tracking("account", claimed.id);
  assert.equal(denied.status, 404);
  assert.deepEqual(await tracking("account", randomUUID(), ownerCookie), denied);
  assert.deepEqual(await tracking("account", claimed.id, otherCookie), denied);
  assert.deepEqual(await tracking("account", unclaimed.id, `${ownerCookie}; ${cookie}`), denied);
  assert.deepEqual(await tracking("guest", claimed.id, cookie), denied);
  assert.deepEqual(await tracking("guest", unclaimed.id, `${guestCookie}=${newGuestToken()}`), denied);
  assert.deepEqual(await tracking("guest", unclaimed.id, cookie, "?after=not-a-cursor"), denied);
  assert.deepEqual(await tracking("guest", unclaimed.reference, cookie), denied);
  assert.deepEqual(await tracking("guest", unclaimed.id, cookie, "", true), denied);
  const expired = `${token.split(".")[0]}.${Math.floor(Date.now() / 1000) - 1}`;
  const expiredSignature = createHmac("sha256", process.env.CHECKOUT_SECRET!).update("guest\0").update(expired).digest("hex");
  assert.deepEqual(await tracking("guest", unclaimed.id, `${guestCookie}=${expired}.${expiredSignature}`), denied);
  assert.deepEqual(await tracking("guest", unclaimed.id, `${cookie.slice(0, -1)}${cookie.endsWith("a") ? "b" : "a"}`), denied);
  const empty = await tracking("guest", unclaimed.id, cookie);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.shipments, []);
  const legacy = await tracking("guest", historical.id, cookie);
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.body.shipments[0].items, []);
  assert.deepEqual(legacy.body.shipments.map((entry: { id: string; recordType: string; lastSyncedAt: string | null }) =>
    ({ id: entry.id, type: entry.recordType, synced: entry.lastSyncedAt })), [
    { id: historical.id, type: "LEGACY_BD", synced: null },
  ]);
  const handoff = await tracking("guest", orderLevelHandoff.id, cookie);
  assert.equal(handoff.status, 200);
  assert.equal(handoff.body.shipments[0].recordType, "LEGACY_ORDER");
  assert.equal(handoff.body.shipments[0].status, "HANDED_TO_CARRIER");
  assert.equal(handoff.body.shipments[0].trackingReference, "LEGACY-PACKAGE");
  assert.equal(handoff.body.shipments[0].statusUpdatedAt, null);
  assert.deepEqual(handoff.body.shipments[0].events, []);
  assert.deepEqual(await tracking("account", claimed.id, ownerCookie), response);
  assert.deepEqual(await sideEffects(), before);
  await db.orderParcel.create({ data: { orderId: unclaimed.id, locationId: locationIds[0], locationName: "Guest fixture warehouse",
    status: "DELIVERED", source: "MANUAL", carrier: "Guest fixture courier", trackingReference: "TRACKING-GUEST-123",
    items: { create: { orderItemId: unclaimed.items[0].id, quantity: 3 } } } });
  const privateGuestParcel = await tracking("guest", unclaimed.id, cookie);
  assert.equal(privateGuestParcel.body.summary.status, "DELIVERED");
  assert.deepEqual(privateGuestParcel.body.shipments[0].items, []);
  assert.doesNotMatch(JSON.stringify(privateGuestParcel.body), /Canvas tote|TOTE-OAT|warehouse|customer-private/i);
  await db.order.update({ where: { id: unclaimed.id }, data: { shopperId: owner.id } });
  assert.deepEqual(await tracking("guest", unclaimed.id, cookie), denied);
  assert.equal((await tracking("account", unclaimed.id, ownerCookie)).status, 200);
});

test("guest refresh is bounded by parcel cursors and a credential's read budget", async t => {
  const token = newGuestToken();
  const cookie = `${guestCookie}=${token}`;
  const order = await fixtureOrder(readGuestKey(token)!);
  const locationId = `cursor-${randomUUID()}`;
  t.after(async () => {
    await removeOrders([order]);
    await db.dispatchLocation.deleteMany({ where: { id: locationId } });
  });
  await db.dispatchLocation.create({ data: { id: locationId, name: "Fixture location", marketId: "bd" } });
  await db.orderParcel.createMany({ data: Array.from({ length: 21 }, () => ({ orderId: order.id, locationId, locationName: "Fixture location" })) });
  const page = await tracking("guest", order.id, cookie);
  assert.equal(page.status, 200);
  assert.equal(page.body.shipments.length, 20);
  assert.ok(page.body.shipments.every((shipment: { status: string }) => shipment.status === "PREPARING"));
  const later = await tracking("guest", order.id, cookie, `?after=${page.body.nextCursor}`);
  assert.equal(later.status, 200);
  assert.equal(later.body.shipments.length, 1);
  assert.equal(later.body.nextCursor, null);
  assert.deepEqual(later.body.summary, page.body.summary);
  assert.equal(later.body.summary.total, 21);
  assert.equal(new Set([...page.body.shipments, ...later.body.shipments].map(entry => entry.id)).size, 21);
  for (let request = 0; request < 28; request++) assert.equal((await tracking("guest", order.id, cookie)).status, 200);
  const limited = await tracking("guest", order.id, cookie);
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, "60");
  assert.equal(limited.body.error.code, "rate_limited");
});
