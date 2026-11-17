import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import "../../scripts/load-env.ts";
import { newGuestToken, readGuestKey } from "../../src/lib/commerce/guest.ts";
import { deliveryChoices, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { AddressError, changeSavedAddress, savedAddresses } from "../../src/lib/marketplace/addresses.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";

test("the address book scopes defaults and mutations and leaves delivery snapshots intact", async t => {
  const db = getDb();
  const owner = randomUUID();
  const outsider = randomUUID();
  const variantId = "v-tote-oat";
  const attempt: { id?: string } = {};
  t.after(async () => {
    try {
      await db.$transaction(async tx => {
        if (attempt.id) {
          const order = await tx.order.findUnique({ where: { attemptId: attempt.id }, select: { id: true } });
          if (order) {
            await tx.fulfillmentEvent.deleteMany({ where: { orderId: order.id } });
            await tx.payment.deleteMany({ where: { orderId: order.id } });
            await tx.orderItem.deleteMany({ where: { orderId: order.id } });
            await tx.order.delete({ where: { id: order.id } });
            await tx.inventory.update({ where: { variantId }, data: { available: { increment: 1 } } });
          }
          await tx.checkoutAttempt.delete({ where: { id: attempt.id } });
        }
        await tx.shopper.deleteMany({ where: { id: { in: [owner, outsider] } } });
      });
    } finally {
      await db.$disconnect();
    }
  });
  await db.shopper.createMany({ data: [owner, outsider].map(id => ({ id, name: "Test shopper", email: `${id}@example.invalid` })) });
  const delivery = (await deliveryChoices("bd")).find(zone => zone.district === "dhaka");
  assert(delivery);
  const details = { country: "BD", name: "Sample Recipient", phone: "০১৭০০০০০০০০", postalCode: "১২০০",
    district: delivery.district, locality: "Sample locality", address: "Sample Street 1", landmark: "Sample Market", alternatePhone: "01800000000" };
  const contact = { action: "create-address", marketId: "bd", label: "Home", details } as const;
  const [first, replay] = await Promise.all([changeSavedAddress(owner, contact), changeSavedAddress(owner, contact)]);
  assert.deepEqual(first, replay);
  const other = await changeSavedAddress(owner, { ...contact, label: "Work", details: { ...details, address: "Sample Street 2" } });
  const unitedStates = await changeSavedAddress(owner, { action: "create-address", marketId: "us", label: "US sample",
    details: { country: "US", name: "Sample Recipient", phone: "202-555-0100", addressLine1: "100 Test Avenue",
      city: "Washington", state: "DC", postalCode: "20001" } });
  assert.deepEqual((await savedAddresses(owner, "us")).map(row => [row.id, row.isDefault]), [[unitedStates.id, true]]);
  assert.deepEqual(await savedAddresses(outsider, "bd"), []);
  for (const [shopperId, marketId] of [[outsider, "bd"], [owner, "us"]] as const) {
    await assert.rejects(changeSavedAddress(shopperId, { action: "remove-address", marketId, address: first.id }),
      (error: unknown) => error instanceof AddressError && error.status === 404);
  }
  await assert.rejects(changeSavedAddress(owner, { ...contact, details: { ...details, district: "unserved" } }), AddressError);
  await changeSavedAddress(owner, { action: "default-address", marketId: "bd", address: other.id });
  const rows = await savedAddresses(owner, "bd");
  assert.deepEqual(rows.map(row => [row.id, row.isDefault]), [[other.id, true], [first.id, false]]);
  const address = rows[1];
  assert(address?.marketId === "bd" && address.details);
  assert.equal(address.details.phone, "+8801700000000");
  assert.equal(address.details.postalCode, "1200");
  assert.equal(address.details.landmark, "Sample Market");

  const guestKey = readGuestKey(newGuestToken());
  assert(guestKey);
  const checkout = { marketId: "bd", items: [{ variantId, quantity: 1 }], customer: address.details,
    paymentMethod: "COD", deliveryMethod: delivery.method };
  const reviewed = await reviewCheckout(checkout, "bd", guestKey);
  assert.equal(reviewed.kind, "review");
  const attemptId = reviewed.attemptId;
  attempt.id = attemptId;
  const placed = await submitCheckout({ ...checkout, attemptId, reviewToken: reviewed.quote.reviewToken }, "bd", guestKey, owner);
  assert.equal(placed.kind, "placed");
  const order = () => db.order.findUniqueOrThrow({ where: { id: placed.orderId }, select: { address: true, phone: true, postalCode: true, shopperId: true } });
  const snapshot = await order();
  assert.equal(snapshot.shopperId, owner);
  assert.match(snapshot.address, /Sample Street 1.*Sample Market.*\+8801800000000/);
  await changeSavedAddress(owner, { ...contact, action: "update-address", address: first.id,
    details: { ...details, address: "Edited Street 3" } });
  await changeSavedAddress(owner, { action: "remove-address", marketId: "bd", address: other.id });
  assert.deepEqual((await savedAddresses(owner, "bd")).map(row => [row.id, row.isDefault]), [[first.id, true]]);
  await changeSavedAddress(owner, { action: "remove-address", marketId: "bd", address: first.id });
  assert.deepEqual(await order(), snapshot);
  assert.deepEqual((await savedAddresses(owner, "us")).map(row => row.id), [unitedStates.id]);
});
