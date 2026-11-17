import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { markets } from "../../src/config/markets.ts";
import { customerOrderDate, customerOrderMoney } from "../../src/lib/commerce/account-order.ts";
import { guestOrder } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { changeSavedAddress, savedAddresses } from "../../src/lib/marketplace/addresses.ts";
import { buyerCasePhoto, buyerOrderCase, casesForShopper, executeOrderCase, staffOrderCase } from "../../src/lib/marketplace/cases.ts";
import { latestShopperOrder, shopperOrders } from "../../src/lib/marketplace/data.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("the third market uses the shared account data paths with local address rules, CAD and scoped staff support", async t => {
  const suffix = randomUUID();
  const shopperId = `account-fixture-${suffix}`;
  const otherId = `account-other-${suffix}`;
  const agentId = `account-ca-agent-${suffix}`;
  const usAgentId = `account-us-agent-${suffix}`;
  const attemptIds = [randomUUID(), randomUUID()];

  t.after(async () => {
    await db.$transaction(async tx => {
      await tx.order.deleteMany({ where: { attemptId: { in: attemptIds }, shopperId } });
      await tx.checkoutAttempt.deleteMany({ where: { id: { in: attemptIds } } });
      await tx.shopper.deleteMany({ where: { id: { in: [shopperId, otherId] } } });
      await tx.user.deleteMany({ where: { id: { in: [agentId, usAgentId] } } });
    });
  });

  const canadaAddress = { country: "CA", name: "Canada Fixture Buyer", phone: "416-555-0100", city: "Ottawa",
    state: "on", postalCode: "k1a0b1", addressLine1: "123 Test Street" };
  await db.shopper.createMany({ data: [shopperId, otherId].map(id => ({ id, email: `${id}@example.invalid`, name: "Fixture Shopper" })) });
  await db.user.create({ data: { id: agentId, email: `${agentId}@example.invalid`, name: "Canada Fixture Staff",
    staff: { create: { role: "OWNER", marketIds: ["ca"] } } } });
  await db.user.create({ data: { id: usAgentId, email: `${usAgentId}@example.invalid`, name: "US Fixture Staff",
    staff: { create: { role: "OWNER", marketIds: ["us"] } } } });

  const saveCommand = { action: "create-address", marketId: "ca", label: "Home", details: canadaAddress } as const;
  await assert.rejects(changeSavedAddress(shopperId, { ...saveCommand, marketId: "us" }), { status: 422 });
  await assert.rejects(changeSavedAddress(shopperId, { ...saveCommand, details: { ...canadaAddress, postalCode: "12345" } }), { status: 422 });
  const address = await changeSavedAddress(shopperId, saveCommand);
  const [saved] = await savedAddresses(shopperId, "ca");
  assert(saved?.marketId === "ca" && saved.details);
  assert.equal(saved.details.postalCode, "K1A 0B1");
  assert.equal(saved.details.phone, "+14165550100");
  assert.equal(saved.details.state, "ON");
  const { phone, postalCode } = saved.details;
  assert.equal(saved.isDefault, true);
  assert.deepEqual(await savedAddresses(shopperId, "us"), []);
  assert.deepEqual(await savedAddresses(shopperId, "bd"), []);
  assert.deepEqual(await savedAddresses(otherId, "ca"), []);
  await assert.rejects(changeSavedAddress(otherId, { action: "remove-address", marketId: "ca", address: address.id }), { status: 404 });

  const date = new Date("2026-11-17T14:00:00Z");
  const orders = await Promise.all((["ca", "us"] as const).map((marketId, index) => db.order.create({ data: {
    attempt: { create: { id: attemptIds[index], guestKey: suffix, requestHash: suffix } },
    reference: `FIXTURE-${marketId.toUpperCase()}-${suffix}`, marketId, currency: markets[marketId].currency, shopper: { connect: { id: shopperId } },
    customerName: canadaAddress.name, phone, district: "on", districtLabel: "Ontario", locality: canadaAddress.city,
    address: canadaAddress.addressLine1, postalCode, deliveryMethod: "sample", deliveryLabel: "Fixture delivery",
    subtotalMinor: 2499, totalMinor: 2499, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, taxLabel: "Tax", measurementTest: true,
    fulfillmentStatus: "DELIVERED", createdAt: date,
  } })));
  const [canadaOrder, usOrder] = orders;
  assert.deepEqual((await shopperOrders(shopperId, null, "ca")).map(order => order.id), [canadaOrder.id]);
  assert.deepEqual((await shopperOrders(shopperId, null, "us")).map(order => order.id), [usOrder.id]);
  assert.deepEqual(await shopperOrders(otherId, null, "ca"), []);
  const latest = await latestShopperOrder(shopperId, "ca");
  assert(latest);
  assert.match(customerOrderMoney(latest.totalMinor, latest.currency, "en"), /CAD\s*24\.99/);
  assert.equal(customerOrderDate(latest.createdAt, "ca", "en"), new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "America/Toronto" }).format(date));
  assert.equal(await guestOrder(canadaOrder.id, null, shopperId, "us"), null);

  const shopper = { id: shopperId, role: "shopper", market: "ca" } as const;
  const report = { action: "open", orderId: canadaOrder.id, kind: "DISPUTE", reason: "OTHER", note: "Please check this fixture receipt." } as const;
  await assert.rejects(executeOrderCase({ ...shopper, market: "us" }, report), { status: 404 });
  await assert.rejects(executeOrderCase(shopper, { ...report, kind: "RETURN" }), { status: 409 });
  const samplePhoto = new Uint8Array([87, 69, 66, 80]);
  const record = await executeOrderCase(shopper, report, samplePhoto);
  assert.equal((await casesForShopper(shopperId, "ca"))[0]?.id, record.id);
  assert.deepEqual(await casesForShopper(shopperId, "us"), []);
  assert.equal(await buyerOrderCase(otherId, canadaOrder.id, record.id, "ca"), null);
  assert.equal(await buyerCasePhoto(shopperId, record.id, "us"), null);
  assert.equal(await staffOrderCase(usAgentId, record.id), null);
  assert.equal((await staffOrderCase(agentId, record.id))?.id, record.id);
});
