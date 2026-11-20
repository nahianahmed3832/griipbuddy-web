import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { carrierTrackingRelayEnabled, parcelTrackingRelayProvider, readCarrierTrackingRelay, supportsParcelTrackingRelay,
  supportsParcelTrackingRelayReference }
  from "../src/lib/commerce/carrier-tracking-relay.ts";

const now = Date.parse("2026-11-19T12:00:00Z");
const secret = randomBytes(32).toString("hex");
const identity = {
  parcelId: "00000000-0000-4000-8000-000000000001",
  carrier: "steadfast",
  trackingReference: "SF-ABC123",
  eventId: "step-001",
  occurredAt: "2026-11-19T17:50:00+06:00",
};

function isolatedRelay(t: TestContext) {
  const keys = ["COMMERCE_MODE", "DATABASE_URL", "GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET"] as const;
  const previous = keys.map(key => process.env[key]);
  Object.assign(process.env, {
    COMMERCE_MODE: "local", DATABASE_URL: "postgresql://127.0.0.1/griipbuddy_test",
    GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET: secret,
  });
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
}

function request(value: unknown, options: { signedAt?: number; key?: string; headers?: Record<string, string>; body?: string } = {}) {
  const body = options.body ?? JSON.stringify(value);
  const timestamp = String(Math.floor((options.signedAt ?? now) / 1000));
  const signature = createHmac("sha256", options.key ?? secret).update(timestamp + ".").update(body).digest("hex");
  return new Request("http://127.0.0.1/api/internal/order-tracking/webhook", { method: "POST", body,
    headers: { "content-type": "application/json", "x-shipping-timestamp": timestamp,
      "x-shipping-signature": signature, ...options.headers } });
}

test("shipping relay maps confirmed carrier facts and keeps the provider code and observation time", async t => {
  isolatedRelay(t);
  const original = { ...identity, occurredAt: new Date("2026-11-19T11:50:00Z") };
  const result = await readCarrierTrackingRelay(request({ ...identity, code: "dispatched", estimatedDeliveryAt: "2026-11-20T12:00:00Z" }), now);
  assert.deepEqual(result, { observation: { ...original, status: "HANDED_TO_CARRIER", providerCode: "dispatched",
    estimatedDeliveryAt: new Date("2026-11-20T12:00:00Z") } });

  for (const [code, status] of [["pending", "PREPARING"], ["customs", "IN_TRANSIT"], ["out_for_delivery", "OUT_FOR_DELIVERY"],
    ["delivered", "DELIVERED"], ["delivered_approval_pending", "IN_TRANSIT"], ["partial_delivered", "DELIVERY_EXCEPTION"],
    ["cancelled", "DELIVERY_EXCEPTION"], ["returned", "RETURNED"]]) {
    assert.deepEqual(await readCarrierTrackingRelay(request({ ...identity, code }), now),
      { observation: { ...original, status, providerCode: code } });
  }
  assert.deepEqual(await readCarrierTrackingRelay(request({ ...identity, error: "RATE_LIMITED" }), now),
    { observation: { ...original, error: "RATE_LIMITED" } });
  assert.equal(parcelTrackingRelayProvider("  Steadfast Courier "), "steadfast");
  assert.equal(supportsParcelTrackingRelay("steadfast-example"), false);
  assert.equal(supportsParcelTrackingRelay(null), false);
  assert.equal(supportsParcelTrackingRelayReference(identity.trackingReference), true);
  assert.equal(supportsParcelTrackingRelayReference("CSV shipment.reference"), false);
  assert.equal(supportsParcelTrackingRelayReference(null), false);
});

test("shipping relay rejects untrusted headers, stale signatures, and nonisolated profiles", async t => {
  isolatedRelay(t);
  const input = { ...identity, code: "dispatched" };
  assert.equal(carrierTrackingRelayEnabled(), true);
  const invalidRequests: NonNullable<Parameters<typeof request>[1]>[] = [
    { key: "different-key" }, { signedAt: now - 301_000 }, { signedAt: now + 301_000 },
    { headers: { "x-shipping-signature": "0".repeat(64) } }, { headers: { origin: "http://127.0.0.1" } },
  ];
  for (const options of invalidRequests) {
    assert.deepEqual(await readCarrierTrackingRelay(request(input, options), now), { errorStatus: 401 });
  }
  assert.deepEqual(await readCarrierTrackingRelay(request(input, { headers: { "content-encoding": "gzip" } }), now), { errorStatus: 415 });
  assert.deepEqual(await readCarrierTrackingRelay(request(input, { body: " ".repeat(16_385) }), now), { errorStatus: 413 });
  process.env.DATABASE_URL = "postgresql://127.0.0.1/griipbuddy_dev";
  assert.deepEqual(await readCarrierTrackingRelay(request(input), now), { errorStatus: 404 });
  process.env.DATABASE_URL = "postgresql://127.0.0.1/griipbuddy_test";
  process.env.COMMERCE_MODE = "production";
  assert.deepEqual(await readCarrierTrackingRelay(request(input), now), { errorStatus: 404 });
  process.env.COMMERCE_MODE = "local";
  process.env.GRIIP_PARCEL_TRACKING_WEBHOOK_SECRET = "insufficient-key";
  assert.equal(carrierTrackingRelayEnabled(), false);
});

test("shipping relay rejects private payloads, conflicting shapes and unsupported observations", async t => {
  isolatedRelay(t);
  assert.deepEqual(await readCarrierTrackingRelay(request(null, { body: "{" }), now), { errorStatus: 400 });
  for (const input of [{ ...identity, code: "delivered", contact: { recipientPhone: "fixture" } },
    { ...identity, carrier: "unverified", code: "delivered" }, { ...identity, code: "unreviewed_provider_code" },
    { ...identity, code: "delivered", error: "RATE_LIMITED" }, { ...identity, error: "raw provider response" },
    { ...identity, code: "delivered", occurredAt: "2026-11-19T12:05:01Z" },
    { ...identity, code: "dispatched", estimatedDeliveryAt: "2026-11-19T11:49:00Z" },
    { ...identity, code: "delivered", trackingReference: "../path" }]) {
    assert.deepEqual(await readCarrierTrackingRelay(request(input), now), { errorStatus: 422 });
  }
});
