import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { addressBook, addressDistricts } from "../../src/lib/marketplace/address-book.ts";
import { buyerSupportThread } from "../../src/lib/marketplace/buyer-support.ts";
import { marketplaceCommand } from "../../src/lib/marketplace/commands.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { threadsFor } from "../../src/lib/marketplace/data.ts";
import { applyMarketplaceCommand, MarketplaceError } from "../../src/lib/marketplace/write.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function fixtureBuyer() {
  const id = randomUUID();
  const row = await db.shopper.create({ data: { id, name: "Test shopper", email: `${id}@example.invalid` } });
  return row.id;
}

function resourceId(result: object) {
  assert.ok("id" in result && typeof result.id === "string");
  return result.id;
}

function marketError(status: number) {
  return (error: unknown) => error instanceof MarketplaceError && error.status === status;
}

test("address book keeps separate markets and roles, one default and restart-safe contact data", async t => {
  const owner = await fixtureBuyer(), other = await fixtureBuyer();
  t.after(() => db.shopper.deleteMany({ where: { id: { in: [owner, other] } } }));
  const districts = await addressDistricts("bd");
  assert.ok(districts.length);
  const [district] = districts;
  const bd = { country: "BD", name: "Test name", email: "", phone: "01700000000", district: district.id,
    locality: "Sample locality", address: "Sample fixture street", postalCode: "" };
  const us = { ...bd, country: "US", phone: "(212) 555-0199", district: "NY", locality: "Synthetic city", postalCode: "10001" };
  const write = (body: object, marketId: "bd" | "us" = "bd", shopperId = owner) =>
    applyMarketplaceCommand(marketplaceCommand.parse(body), { shopperId, marketId });
  const body = { action: "save-address", label: "BD delivery", customer: bd, operationId: randomUUID() };
  const first = await write(body);
  const firstId = resourceId(first);
  assert.deepEqual(await write(body), first);
  await assert.rejects(write({ ...body, label: "Changed create payload" }), marketError(409));
  await assert.rejects(write({ ...body, customer: { ...bd, district: "unconfigured" } }), marketError(422));
  await assert.rejects(write({ ...body, customer: us }), marketError(422));
  await assert.rejects(write({ ...body, marketId: "us" }), marketError(409));

  const second = await write({ ...body, operationId: randomUUID(), label: "BD alternative" });
  const secondId = resourceId(second);
  const billing = await write({ ...body, kind: "BILLING", label: "US invoice contact", customer: us, operationId: randomUUID() }, "us");
  const shipping = await write({ ...body, label: "US shipping", customer: us, operationId: randomUUID() }, "us");
  const billingId = resourceId(billing), shippingId = resourceId(shipping);

  const setDefault = (address: string, kind = "SHIPPING") => ({ action: "default-address", address, kind });
  await Promise.all([write(setDefault(firstId)), write(setDefault(secondId))]);
  assert.equal((await addressBook(owner, "bd", "SHIPPING")).filter(row => row.isDefault).length, 1);
  await write(setDefault(billingId, "BILLING"), "us");
  await write(setDefault(shippingId), "us");
  assert.equal((await addressBook(owner, "us", "SHIPPING"))[0].label, "US shipping");
  assert.equal((await addressBook(owner, "us", "BILLING"))[0].details?.postalCode, "10001");

  await assert.rejects(write(setDefault(firstId), "us"), marketError(404));
  await assert.rejects(write(setDefault(firstId), "bd", other), marketError(404));
  await assert.rejects(write(setDefault(billingId), "us"), marketError(404));
  await assert.rejects(write({ action: "delete-address", address: shippingId }, "us", other), marketError(404));
  await write({ ...body, address: firstId, label: "BD address edited", operationId: undefined });
  assert.equal((await addressBook(owner, "bd")).find(row => row.id === firstId)?.label, "BD address edited");
  assert.deepEqual(await addressBook(other, "bd"), []);
  assert.deepEqual(await addressBook(other, "us"), []);
  await write({ action: "delete-address", address: shippingId }, "us");
  assert.deepEqual(await addressBook(owner, "us", "SHIPPING"), []);
  assert.equal((await addressBook(owner, "us", "BILLING")).length, 1);

  const legacy = await db.shopperAddress.create({ data: { shopperId: owner, label: "Historical fixture",
    details: { name: bd.name, phone: bd.phone, district: bd.district, locality: bd.locality, address: bd.address, email: null, postalCode: null } } });
  assert.equal((await addressBook(owner, "bd")).find(row => row.id === legacy.id)?.details?.district, district.id);
});

test("private platform support tickets retain replies within owner and market scope", async t => {
  const shopper = await fixtureBuyer(), other = await fixtureBuyer();
  t.after(async () => {
    const rows = await db.shopperRequest.findMany({ where: { shopperId: shopper }, select: { id: true } });
    const ids = rows.map(row => row.id);
    await db.auditEvent.deleteMany({ where: { target: { in: ids } } });
    await db.sellerHubOperation.deleteMany({ where: { resourceId: { in: ids } } });
    await db.shopperRequest.deleteMany({ where: { id: { in: ids } } });
    await db.shopper.deleteMany({ where: { id: { in: [shopper, other] } } });
  });
  const staff = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const open = { action: "open-message" as const, shop: storeShop.id, operationId: randomUUID(),
    subject: "Sample support ticket", text: "This is a private synthetic request." };
  const first = await applyMarketplaceCommand(open, { shopperId: shopper, marketId: "bd" });
  const threadId = resourceId(first);
  assert.deepEqual(await applyMarketplaceCommand(open, { shopperId: shopper, marketId: "bd" }), first);
  assert.equal(await buyerSupportThread(threadId, { shopperId: other, marketId: "bd" }), null);
  assert.equal(await buyerSupportThread(threadId, { shopperId: shopper, marketId: "us" }), null);
  assert.equal(await buyerSupportThread(threadId, { staffOwner: true, marketId: "us" }), null);
  assert.ok((await threadsFor({ shopperId: shopper }, "bd")).some(row => row.id === threadId));
  assert.ok(!(await threadsFor({ shopperId: shopper }, "us")).some(row => row.id === threadId));

  const reply = { action: "reply" as const, thread: threadId, operationId: randomUUID(), text: "Synthetic staff reply." };
  const staffActor = { staffOwner: true, staffActorId: staff.userId };
  await assert.rejects(applyMarketplaceCommand(reply, { ...staffActor, marketId: "us" }), marketError(404));
  await applyMarketplaceCommand(reply, { ...staffActor, marketId: "bd" });
  await applyMarketplaceCommand(reply, { ...staffActor, marketId: "bd" });
  const saved = await buyerSupportThread(threadId, { shopperId: shopper, marketId: "bd" });
  assert.equal(saved?.messages.length, 2);
  assert.ok(saved?.messages[0].fromShop);
  await applyMarketplaceCommand({ action: "close-thread", thread: threadId }, { ...staffActor, marketId: "bd" });
  assert.equal((await buyerSupportThread(threadId, { shopperId: shopper, marketId: "bd" }))?.closed, true);
  await assert.rejects(applyMarketplaceCommand({ ...reply, operationId: randomUUID() }, { shopperId: shopper, marketId: "bd" }), marketError(409));
});
