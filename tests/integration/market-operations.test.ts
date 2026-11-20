import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { markets } from "../../src/config/markets.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { advanceFulfillment, listStaffOrders, staffOrder } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("packing permissions scope both order read paths and mutations", async t => {
  const packer = randomUUID();
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const fixtures = [markets.bd, markets.us].map(market => ({ market, id: randomUUID(), attempt: randomUUID() }));
  t.after(async () => {
    const ids = fixtures.map(row => row.id);
    await db.$transaction(async tx => {
      await tx.fulfillmentEvent.deleteMany({ where: { orderId: { in: ids } } });
      await tx.auditEvent.deleteMany({ where: { target: { in: ids } } });
      await tx.payment.deleteMany({ where: { orderId: { in: ids } } });
      await tx.order.deleteMany({ where: { id: { in: ids } } });
      await tx.checkoutAttempt.deleteMany({ where: { id: { in: fixtures.map(row => row.attempt) } } });
      await tx.user.deleteMany({ where: { id: packer } });
    });
  });
  await db.$transaction(async tx => {
    await tx.user.create({ data: {
      id: packer, name: "Operations fixture", email: `${packer}@example.invalid`,
      staff: { create: { role: "PACKER", marketGrants: { create: [
        { marketId: "bd", operations: true }, { marketId: "us", reporting: true, merchandising: true },
      ] } } },
    } });
    for (const { market, id, attempt } of fixtures) {
      await tx.checkoutAttempt.create({ data: { id: attempt, guestKey: attempt.replaceAll("-", "").repeat(2),
        requestHash: id.replaceAll("-", "").repeat(2) } });
      await tx.order.create({ data: {
        id, attemptId: attempt, reference: `fixture-${id}`, marketId: market.id, currency: market.currency,
        measurementTest: true, customerName: "Sample shopper", phone: "0000000000", district: "fixture",
        districtLabel: "Fixture district", locality: "Fixture locality", address: "Synthetic fixture address",
        deliveryMethod: "manual", deliveryLabel: "Synthetic handoff", taxLabel: "Fixture tax",
        subtotalMinor: 100, totalMinor: 100, discountMinor: 0, deliveryMinor: 0, taxMinor: 0,
        payment: { create: { method: "COD", amountMinor: 100, currency: market.currency } },
      } });
    }
  });
  const [bd, us] = fixtures;
  const queue = await listStaffOrders(packer, "all", 1);
  assert.ok(queue.rows.some(row => row.id === bd.id));
  assert.ok(!queue.rows.some(row => row.id === us.id));
  assert.ok(await staffOrder(packer, bd.id));
  assert.equal(await staffOrder(packer, us.id), null);
  await assert.rejects(advanceFulfillment(packer, us.id, { next: "PACKING" }), /not found/i);
  await advanceFulfillment(packer, bd.id, { next: "PACKING" });
  assert.equal((await staffOrder(owner.userId, bd.id))?.fulfillmentStatus, "PACKING");
  assert.equal((await staffOrder(owner.userId, us.id))?.fulfillmentStatus, "UNFULFILLED");
  await db.staffMarketAccess.update({ where: { userId_marketId: { userId: packer, marketId: "bd" } }, data: { operations: false } });
  assert.equal(await staffOrder(packer, bd.id), null);
  await assert.rejects(advanceFulfillment(packer, bd.id, { next: "READY_TO_SHIP" }), /not found/i);
});
