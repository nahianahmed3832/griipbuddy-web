import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { POST as acceptCarrierObservation } from "../../src/app/api/internal/order-tracking/webhook/route.ts";
import { refreshOrderParcelTracking } from "../../src/lib/commerce/order-parcel-tracking.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { CatalogWriteError } from "../../src/lib/staff/operation-error.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("the verified carrier relay records native shipment events without touching commerce state", async t => {
  const secret = randomBytes(32).toString("hex");
  const previousSecret = process.env.GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET;
  process.env.GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET;
    else process.env.GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET = previousSecret;
  });

  const locationId = `relay-warehouse-${randomUUID()}`;
  const orderId = randomUUID();
  const attemptId = randomUUID();
  const parcelId = randomUUID();
  const trackingReference = `SF-${randomBytes(8).toString("hex")}`;
  const secondParcelId = randomUUID();
  const secondReference = `SF-${randomBytes(8).toString("hex")}`;
  const ownerId = `relay-owner-${randomUUID()}`;
  const scopedActorId = `relay-packer-${randomUUID()}`;
  const base = Date.now() - 600_000;
  const observed = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const identity = { parcelId, carrier: "steadfast", trackingReference };
  await db.$transaction(async tx => {
    await tx.user.create({ data: { id: ownerId, email: `${ownerId}@example.invalid`, name: "Fixture owner",
      staff: { create: { role: "OWNER" } } } });
    await tx.user.create({ data: { id: scopedActorId, email: `${scopedActorId}@example.invalid`, name: "Fixture market packer",
      staff: { create: { role: "PACKER", marketGrants: { create: { marketId: "us", operations: true } } } } } });
    await tx.dispatchLocation.create({ data: { id: locationId, name: "Fixture warehouse", marketId: "bd" } });
    await tx.checkoutAttempt.create({ data: { id: attemptId, guestKey: randomBytes(32).toString("hex"),
      requestHash: randomBytes(32).toString("hex"), marketId: "bd", paymentMethod: "COD" } });
    await tx.order.create({ data: { id: orderId, attemptId, reference: `RELAY-${orderId}`, marketId: "bd", currency: "BDT",
      fulfillmentStatus: "SHIPPED", measurementTest: true, customerName: "Synthetic shopper", phone: "01700000000",
      district: "dhaka", districtLabel: "Dhaka", locality: "Fixture locality", address: "Fixture address",
      deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "VAT",
      subtotalMinor: 1000, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor: 1000,
      payment: { create: { method: "COD", status: "AWAITING_COLLECTION", amountMinor: 1000, currency: "BDT" } },
      parcels: { create: [{ id: parcelId, trackingReference }, { id: secondParcelId, trackingReference: secondReference }]
        .map(parcel => ({ ...parcel, locationId, locationName: "Fixture warehouse", status: "IN_TRANSIT",
          carrier: "Steadfast Courier", source: "MANUAL", statusUpdatedAt: new Date(base) })) } } });
  });
  t.after(async () => {
    await db.$transaction([
      db.auditEvent.deleteMany({ where: { target: orderId } }),
      db.fulfillmentEvent.deleteMany({ where: { orderId } }),
      db.payment.deleteMany({ where: { orderId } }),
      db.order.delete({ where: { id: orderId } }),
      db.checkoutAttempt.delete({ where: { id: attemptId } }),
      db.dispatchLocation.delete({ where: { id: locationId } }),
      db.user.deleteMany({ where: { id: { in: [ownerId, scopedActorId] } } }),
    ]);
  });

  async function signed(event: object, expected = 200, key = secret) {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", key).update(timestamp + ".").update(body).digest("hex");
    const response = await acceptCarrierObservation(new Request("http://127.0.0.1/api/internal/order-tracking/webhook", {
      method: "POST", body, headers: { "content-type": "application/json", "x-shipping-timestamp": timestamp,
        "x-shipping-signature": signature },
    }));
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    if (response.ok) return await response.json() as { duplicate: boolean; applied: boolean };
    assert.equal(await response.text(), "");
  }

  const first = { ...identity, eventId: "route-out-for-delivery", code: "out_for_delivery", occurredAt: observed(5),
    estimatedDeliveryAt: new Date(base + 86_400_000).toISOString() };
  const movements = await db.inventoryMovement.count();
  await signed(first, 401, "wrong-signing-key");
  await signed({ ...first, trackingReference: "unmatched-reference" }, 404);
  await db.order.update({ where: { id: orderId }, data: { measurementTest: false } });
  await signed(first, 404);
  await db.order.update({ where: { id: orderId }, data: { measurementTest: true, commercialSnapshot: { fulfillment: ["manual"] } } });
  await signed(first, 404);
  await db.order.update({ where: { id: orderId }, data: { commercialSnapshot: { fulfillment: ["manual", "steadfast"] } } });
  const commerceFields = { status: true, cancelledAt: true, payment: true } as const;
  const orderBefore = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: commerceFields });

  assert.deepEqual(await signed(first), { duplicate: false, applied: true });
  assert.equal((await signed(first))?.duplicate, true);
  assert.equal(await db.auditEvent.count({ where: { target: orderId, changes: { path: ["operationId"], equals: "steadfast:route-out-for-delivery" } } }), 1);
  await signed({ ...first, code: "delivered" }, 409);
  const afterFirst = await db.orderParcel.findUniqueOrThrow({ where: { id: parcelId } });
  assert.equal(afterFirst.trackingStatus, "OUT_FOR_DELIVERY");
  assert.equal(afterFirst.estimatedDeliveryAt?.toISOString(), first.estimatedDeliveryAt);
  assert.equal(afterFirst.trackingOccurredAt?.toISOString(), first.occurredAt);
  assert.ok(afterFirst.trackingSyncedAt && afterFirst.trackingSyncedAt > new Date(first.occurredAt));
  await assert.rejects(refreshOrderParcelTracking(scopedActorId, orderId, parcelId),
    (error: unknown) => error instanceof CatalogWriteError && error.status === 404);
  const refreshed = await refreshOrderParcelTracking(ownerId, orderId, parcelId);
  assert.deepEqual(refreshed.lastSyncedAt, afterFirst.trackingSyncedAt);
  await assert.rejects(refreshOrderParcelTracking(ownerId, orderId, parcelId),
    (error: unknown) => error instanceof CatalogWriteError && error.status === 429);
  assert.deepEqual(await db.orderParcel.findUniqueOrThrow({ where: { id: parcelId } }), afterFirst);

  await signed({ ...identity, eventId: "route-sync-failure", error: "UNAVAILABLE", occurredAt: observed(6) });
  const afterFailure = await db.orderParcel.findUniqueOrThrow({ where: { id: parcelId } });
  assert.equal(afterFailure.trackingStatus, "OUT_FOR_DELIVERY");
  assert.equal(afterFailure.trackingSyncError, "UNAVAILABLE");
  assert.deepEqual(afterFailure.trackingSyncedAt, afterFirst.trackingSyncedAt);

  const late = { ...identity, eventId: "route-earlier-status", code: "in_transit", occurredAt: observed(2) };
  assert.deepEqual(await signed(late), { duplicate: false, applied: false });
  await signed({ ...late, code: "customs" }, 409);
  assert.equal((await db.orderParcel.findUniqueOrThrow({ where: { id: parcelId } })).trackingStatus, "OUT_FOR_DELIVERY");
  assert.deepEqual(await signed({ ...identity, eventId: "route-delivery", code: "delivered", occurredAt: observed(8) }),
    { duplicate: false, applied: true });
  const final = await db.orderParcel.findUniqueOrThrow({ where: { id: parcelId } });
  assert.equal(final.trackingStatus, "DELIVERED");
  assert.equal(final.status, "DELIVERED");
  assert.equal(final.trackingSyncError, null);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus, "SHIPPED");
  assert.deepEqual(await signed({ ...identity, parcelId: secondParcelId, trackingReference: secondReference,
    eventId: "route-delivery", code: "delivered", occurredAt: observed(9) }), { duplicate: false, applied: true });
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus, "DELIVERED");

  const observations = await db.parcelTrackingObservation.findMany({ where: { parcelId }, orderBy: { occurredAt: "asc" } });
  assert.deepEqual(observations.map(row => [row.providerCode, row.status, row.error]), [
    ["in_transit", "IN_TRANSIT", null], ["out_for_delivery", "OUT_FOR_DELIVERY", null],
    [null, null, "UNAVAILABLE"], ["delivered", "DELIVERED", null],
  ]);
  assert.equal(observations.every(row => row.source === "CARRIER_WEBHOOK" && row.actorId === null && row.recordedAt > row.occurredAt), true);
  assert.deepEqual(await db.order.findUniqueOrThrow({ where: { id: orderId }, select: commerceFields }), orderBefore);
  assert.equal(await db.inventoryMovement.count(), movements);
  assert.equal(await db.codRemittance.count({ where: { orderId } }), 0);
});
