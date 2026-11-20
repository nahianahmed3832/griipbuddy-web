import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { config } from "dotenv";
import { bridgeSignatureDomain, type BridgeEnvelope } from "../../src/lib/measurement/bridge-contract.ts";
import { provisionBridgeHandoff } from "../../src/lib/measurement/bridge-consent.ts";
import {
  bridgeOrderSelect, importOutcomeBridge, projectBridgeOutcomes, verifyOutcomeBridge,
} from "../../src/lib/measurement/bridge-outcomes.ts";
import { cookieId, grantMeasurement, revokeMeasurement } from "../../src/lib/measurement/server.ts";
import { stableMeasurementId } from "../../src/lib/measurement/domain.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";

config({ path: ".env.test", override: true, quiet: true });
requireLocalDatabase("griipbuddy_test");
const authority = `bridge-test-${randomBytes(8).toString("hex")}`;
const secret = randomBytes(32).toString("hex");
process.env.GRIIP_OUTCOME_BRIDGE_AUTHORITY = authority;
process.env.GRIIP_OUTCOME_BRIDGE_MARKET = "bd";
process.env.GRIIP_OUTCOME_BRIDGE_SECRET = secret;
process.env.GRIIP_OUTCOME_HANDOFF_SECRET = randomBytes(32).toString("hex");
process.env.GRIIP_OUTCOME_BRIDGE_ENABLED = "1";
process.env.ACQUISITION_MEASUREMENT = "1";
const db = getDb();
const orderId = (source: string) => stableMeasurementId("bridge-order", authority, "bd", "fixture", source);
const linkLines = [{ variantId: "v-bridge-fixture", quantity: 2 }];

function stagedOrder(sourceOrderId = randomUUID(), bookedAt = new Date().toISOString()): BridgeEnvelope["orders"][number] {
  return { sourceOrderId, currency: "BDT", paymentMethod: "COD", bookedAt, subtotalMinor: 10_000,
    discountMinor: 500, taxMinor: 500, deliveryMinor: 1_000, totalMinor: 11_000, lines: linkLines,
    events: [
      { sourceEventId: sourceOrderId + ":order", kind: "ORDER_ACCEPTED", at: bookedAt, amountMinor: 11_000 },
      { sourceEventId: sourceOrderId + ":delivery", kind: "ORDER_DELIVERED", at: bookedAt },
      { sourceEventId: sourceOrderId + ":collection", kind: "COD_COLLECTED", at: bookedAt, amountMinor: 11_000 },
      { sourceEventId: sourceOrderId + ":remittance", kind: "COD_REMITTED", at: bookedAt, amountMinor: 10_900,
        grossMinor: 11_000, deductionsMinor: 100 },
    ],
  };
}

function signed(orders: BridgeEnvelope["orders"], overrides: Partial<BridgeEnvelope> = {}) {
  const body = JSON.stringify({ version: 1, authority, marketId: "bd", evidence: "fixture", orders, ...overrides });
  const signature = createHmac("sha256", secret).update(bridgeSignatureDomain).update(body).digest("hex");
  return Buffer.from(signature + "\n" + body);
}

test.after(async () => {
  await db.bridgeOutcome.deleteMany({ where: { order: { authority } } });
  await db.bridgeOrder.deleteMany({ where: { authority } });
  await db.$disconnect();
});

test("signed bridge imports additive outcomes and rejects tampering and inconsistent evidence", async () => {
  const row = stagedOrder();
  const order = { ...row, events: row.events.slice(0, 1) };
  assert.deepEqual(await importOutcomeBridge(signed([order])), { ordersReceived: 1, ordersCreated: 1, eventsCreated: 1, linksCreated: 0 });
  await assert.rejects(verifyOutcomeBridge(signed([row])), /lifecycle differs/);
  assert.deepEqual(await importOutcomeBridge(signed([row])), { ordersReceived: 1, ordersCreated: 0, eventsCreated: 3, linksCreated: 0 });
  assert.deepEqual(await importOutcomeBridge(signed([row])), { ordersReceived: 1, ordersCreated: 0, eventsCreated: 0, linksCreated: 0 });

  const cutoff = new Date(+new Date(row.bookedAt) + 1);
  const saved = await db.bridgeOrder.findUniqueOrThrow({ where: { id: orderId(row.sourceOrderId) }, select: bridgeOrderSelect });
  const projection = projectBridgeOutcomes(saved, cutoff);
  assert.deepEqual(new Set(projection.map(event => event.kind)), new Set(row.events.map(event => event.kind)));
  const remitted = projection.find(event => event.kind === "COD_REMITTED")!;
  assert.equal(remitted.evidence, "fixture");
  assert.equal(remitted.source, "external-bridge");
  assert.equal(remitted.marketId, "bd");
  assert.equal(remitted.currency, "BDT");
  assert.equal(remitted.amountMinor, 10_900);
  assert.equal(remitted.grossMinor, 11_000);
  assert.equal(remitted.deductionsMinor, 100);
  assert.equal(remitted.journeyId, null);
  const verified = await verifyOutcomeBridge(signed([row]));
  assert.deepEqual([verified.authority, verified.marketId, verified.evidence], [authority, "bd", "fixture"]);
  assert.equal(verified.orders.length, 1);
  assert.deepEqual(Object.keys(verified.orders[0]).sort(), ["currency", "day", "events", "totalMinor"]);
  assert.deepEqual(verified.orders[0].events.map(event => [event.kind, event.reference, event.amountMinor]),
    row.events.map(event => [
      event.kind, stableMeasurementId("bridge-outcome", authority, "bd", "fixture", event.sourceEventId).slice(0, 12),
      event.amountMinor ?? null,
    ]));

  const wire = signed([row]);
  wire[wire.length - 2] = 32;
  await assert.rejects(importOutcomeBridge(wire), /signature/);
  await assert.rejects(verifyOutcomeBridge(wire), /signature/);
  await assert.rejects(importOutcomeBridge(signed([row], { marketId: "us" })), /authority or market/);
  await assert.rejects(importOutcomeBridge(signed([{ ...row, currency: "USD" }])), /currency/);
  await assert.rejects(importOutcomeBridge(signed([{ ...row, deliveryMinor: 100 }])), /amounts do not reconcile/);
  await assert.rejects(importOutcomeBridge(signed([{ ...row, events: row.events.filter(event => event.kind !== "ORDER_DELIVERED") }])), /prerequisite/);
  const changed = { ...row, events: row.events.map(event => event.kind === "COD_REMITTED"
    ? { ...event, amountMinor: 10_800, deductionsMinor: 200 } : event) };
  await assert.rejects(importOutcomeBridge(signed([stagedOrder(), changed])), /conflicts/);
  assert.equal(await db.bridgeOrder.count({ where: { authority } }), 1);
  assert.equal(await db.bridgeOutcome.count({ where: { orderId: saved.id } }), 4);
});

test("handoff requires signed consent, binds exact cart and consumes one order; withdrawal unlinks without deleting outcomes", async () => {
  const consentCookie = await grantMeasurement();
  const journeyId = cookieId(consentCookie)!;
  const sessionId = randomUUID();
  const request = { headers: new Headers(), consentCookie, sessionId, marketId: "bd" as const, lines: linkLines };
  try {
    assert.equal(await provisionBridgeHandoff(request), null);
    await db.measurementEvent.create({
      data: { id: stableMeasurementId("bridge-test-start", journeyId), journeyId, kind: "CHECKOUT_START", marketId: "bd", sessionId },
    });
    assert.equal(await provisionBridgeHandoff({ ...request, consentCookie: "forged" }), null);
    assert.equal(await provisionBridgeHandoff({ ...request, headers: new Headers({ "sec-gpc": "1" }) }), null);
    assert.equal(await provisionBridgeHandoff({ ...request, marketId: "us" }), null);
    const linkProof = await provisionBridgeHandoff(request);
    assert.ok(linkProof);
    const mismatch = { ...stagedOrder(), lines: [{ variantId: "v-bridge-other", quantity: 2 }], linkProof };
    assert.equal((await importOutcomeBridge(signed([mismatch]))).linksCreated, 0);
    const linked = { ...stagedOrder(), linkProof };
    assert.equal((await importOutcomeBridge(signed([linked]))).linksCreated, 1);
    assert.equal((await importOutcomeBridge(signed([linked]))).linksCreated, 0);
    const duplicate = { ...stagedOrder(), linkProof };
    await assert.rejects(importOutcomeBridge(signed([duplicate])), /consumed/);
    const stored = await db.bridgeOrder.findUniqueOrThrow({ where: { id: orderId(linked.sourceOrderId) }, select: bridgeOrderSelect });
    assert.equal(stored.measurement?.journeyId, journeyId);
    assert.equal(stored.measurement?.sessionId, sessionId);

    await revokeMeasurement(consentCookie);
    const revoked = await db.bridgeOrder.findUniqueOrThrow({ where: { id: stored.id }, select: bridgeOrderSelect });
    assert.equal(revoked.events.length, 4);
    assert.equal(revoked.measurement, null);
    assert.equal((await importOutcomeBridge(signed([linked]))).linksCreated, 0);
  } finally {
    await revokeMeasurement(consentCookie);
  }
});
