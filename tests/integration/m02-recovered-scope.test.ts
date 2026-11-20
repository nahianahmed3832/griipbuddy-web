import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { listRecoveredOrders, readRecoveredOrder, recoverRecovered } from "../../src/lib/commerce/integrated-checkout.ts";
import { readOrderTracking } from "../../src/lib/commerce/order-tracking.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("recovered checkout never forwards a wrong-market attempt and verifies the returned receipt scope", async t => {
  const foreign = randomUUID();
  const owned = randomUUID();
  const guestKey = randomBytes(32).toString("hex");
  const previous = process.env.GRIIP_RECOVERED_CHECKOUT;
  process.env.GRIIP_RECOVERED_CHECKOUT = "http://127.0.0.1:38100";
  t.after(async () => {
    if (previous === undefined) delete process.env.GRIIP_RECOVERED_CHECKOUT;
    else process.env.GRIIP_RECOVERED_CHECKOUT = previous;
    await db.checkoutAttempt.deleteMany({ where: { id: { in: [foreign, owned] } } });
  });
  const recoveredCart = { id: randomBytes(12).toString("hex"), revision: 1, token: "synthetic-cart-only" };
  await db.checkoutAttempt.createMany({ data: [
    { id: foreign, marketId: "us", guestKey, requestHash: randomBytes(32).toString("hex"), recoveredCart },
    { id: owned, marketId: "bd", guestKey, requestHash: randomBytes(32).toString("hex"), recoveredCart },
  ] });
  let currency = "USD";
  const transport = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.endsWith(owned));
    return Response.json({ success: true, data: { attempt: owned, currency } });
  });
  assert.equal((await recoverRecovered(foreign, guestKey, "bd")).kind, "conflict");
  assert.equal((await recoverRecovered(owned, guestKey, "us")).kind, "conflict");
  assert.equal(await readRecoveredOrder(foreign, guestKey), null);
  assert.equal(transport.mock.callCount(), 0);
  await assert.rejects(readRecoveredOrder(owned, guestKey), /inconsistent receipt/);
  currency = "BDT";
  assert.equal((await readRecoveredOrder(owned, guestKey))?.attempt, owned);
  assert.equal((await listRecoveredOrders(guestKey)).length, 1);
  assert.equal(transport.mock.callCount(), 3);
  assert.equal((await db.checkoutAttempt.findUniqueOrThrow({ where: { id: foreign } })).abandonedAt, null);
});

test("a bound recovered receipt is readable by its account without the original browser and does not forward foreign proof", async t => {
  const id = randomUUID();
  const shopperId = randomUUID();
  const guestKey = randomBytes(32).toString("hex");
  const previous = process.env.GRIIP_RECOVERED_CHECKOUT;
  process.env.GRIIP_RECOVERED_CHECKOUT = "http://127.0.0.1:38100";
  t.after(async () => {
    if (previous === undefined) delete process.env.GRIIP_RECOVERED_CHECKOUT;
    else process.env.GRIIP_RECOVERED_CHECKOUT = previous;
    await db.checkoutAttempt.deleteMany({ where: { id } });
  });
  await db.checkoutAttempt.create({ data: {
    id, marketId: "bd", paymentMethod: "COD", guestKey, reviewActor: `shopper:${shopperId}`,
    cartSource: "cart", cartRevision: 3, requestHash: randomBytes(32).toString("hex"),
    recoveredCart: { id: randomBytes(12).toString("hex"), revision: 1, token: "synthetic-cart-only" },
  } });
  const transport = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.endsWith(id));
    return Response.json({ success: true, data: { attempt: id, currency: "BDT", status: "placed", number: "RECOVERED-SAFE",
      fulfillment: "SHIPPED", tracking: "COURIER-RECOVERED-TEST", destination: { name: "Private recovered customer" },
      original: { lines: [{ variantId: "fixture", title: "Recovered test item", sku: "FIXTURE", quantity: 2 }] } } });
  });
  assert.equal((await recoverRecovered(id, guestKey, "bd", randomUUID())).kind, "conflict");
  assert.equal(await readRecoveredOrder(id, guestKey), null);
  assert.equal(await readRecoveredOrder(id, guestKey, randomUUID()), null);
  assert.equal(await readOrderTracking(id, { guestKey }, null), null);
  assert.deepEqual(await listRecoveredOrders(guestKey, randomUUID()), []);
  assert.equal(transport.mock.callCount(), 0);
  assert.equal((await readRecoveredOrder(id, null, shopperId))?.attempt, id);
  assert.equal((await listRecoveredOrders(null, shopperId))[0]?.id, id);
  const tracking = await readOrderTracking(id, { shopperId }, null);
  assert.equal(tracking?.summary.status, "SHIPPED");
  assert.equal(tracking?.marketId, "bd");
  assert.equal(tracking?.shipments[0]?.trackingReference, "COURIER-RECOVERED-TEST");
  assert.equal(tracking?.shipments[0]?.items[0]?.quantity, 2);
  assert.doesNotMatch(JSON.stringify(tracking), /Private recovered customer|destination|customerName|guestKey/);
  assert.equal(transport.mock.callCount(), 3);
});
