import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { handleMainAdminCatalog } from "../../src/lib/catalog/main-admin-api.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { executeOrderCase } from "../../src/lib/marketplace/cases.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("main admin order commands use exact purchase snapshots and existing market-scoped packing and case services", async t => {
  const suffix = randomUUID();
  const owner = { id: `main-order-owner-${suffix}`, legacyId: randomBytes(12).toString("hex"), role: "OWNER" } as const;
  const packer = { id: `main-order-packer-${suffix}`, legacyId: randomBytes(12).toString("hex"), role: "PACKER" } as const;
  const buyer = { id: `main-order-shopper-${suffix}`, role: "shopper" } as const;
  const secret = randomBytes(48).toString("hex");
  const settings = {
    GRIIP_MARKETPLACE_PREVIEW: "1",
    GRIIP_MAIN_ADMIN_CATALOG_ORIGIN: "http://127.0.0.1:4361",
    GRIIP_MAIN_ADMIN_CATALOG_SECRET: secret,
    GRIIP_MAIN_ADMIN_CATALOG_ACTORS: JSON.stringify({ [owner.legacyId]: owner.id, [packer.legacyId]: packer.id }),
  };
  const previous = new Map(Object.keys(settings).map(name => [name, process.env[name]]));
  Object.assign(process.env, settings);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const variantId = "v-tote-oat";
  const original = await db.inventory.findUniqueOrThrow({ where: { variantId }, select: { available: true } });
  const created: { attemptId?: string; orderId?: string } = {};
  t.after(async () => {
    const { attemptId, orderId } = created;
    await db.$transaction(async tx => {
      if (orderId) {
        const cases = await tx.orderCase.findMany({ where: { orderId }, select: { id: true } });
        await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
        await tx.payment.deleteMany({ where: { orderId } });
        await tx.auditEvent.deleteMany({ where: { target: { in: [orderId, ...cases.map(entry => entry.id)] } } });
        await tx.orderCase.deleteMany({ where: { orderId } });
        await tx.orderItem.deleteMany({ where: { orderId } });
        await tx.order.delete({ where: { id: orderId } });
        await tx.inventory.update({ where: { variantId }, data: original });
      }
      if (attemptId) await tx.checkoutAttempt.delete({ where: { id: attemptId } });
      await tx.shopper.deleteMany({ where: { id: buyer.id } });
      await tx.user.deleteMany({ where: { id: { in: [owner.id, packer.id] } } });
    });
  });

  for (const actor of [owner, packer]) {
    await db.user.create({ data: { id: actor.id, name: actor.role === "OWNER" ? "Fixture market owner" : "Fixture packer",
      email: `${actor.id}@example.invalid`, staff: { create: { role: actor.role, ...(actor.role === "PACKER" && {
        marketGrants: { create: { marketId: "bd", operations: true } },
      }) } } } });
  }
  await db.shopper.create({ data: { id: buyer.id, email: `${buyer.id}@example.test`, name: "Order Fixture Shopper" } });

  async function signed(operation: object, expected = 200, actor: typeof owner | typeof packer = owner, marketId = "bd") {
    const body = JSON.stringify({ issuedAt: Date.now(), nonce: randomUUID(), legacyId: actor.legacyId,
      central: actor.role === "OWNER", marketId, request: operation });
    const signature = createHmac("sha256", secret).update("griip-main-admin-catalog-v1\n").update(body).digest("hex");
    const response = await handleMainAdminCatalog(new Request("http://127.0.0.1:3100/api/internal/main-admin-catalog", {
      method: "POST", headers: { "content-type": "application/json", "x-griip-catalog-signature": signature }, body,
    }));
    const payload = await response.json();
    assert.equal(response.status, expected, JSON.stringify(payload));
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    return payload.data;
  }

  const checkout: CheckoutDetails = { marketId: "bd", items: [{ variantId, quantity: 2 }],
    customer: { name: "Order Fixture Shopper", phone: "01700000000", district: "dhaka", locality: "Dhanmondi", address: "Test delivery address" },
    deliveryMethod: "standard", paymentMethod: "COD" };
  const guestKey = randomBytes(32).toString("hex");
  const quote = await reviewCheckout(checkout, "bd", guestKey);
  assert.equal(quote.kind, "review");
  const attemptId = quote.attemptId;
  created.attemptId = attemptId;
  const placed = await submitCheckout({ ...checkout, attemptId, reviewToken: quote.quote.reviewToken }, "bd", guestKey, buyer.id);
  assert.equal(placed.kind, "placed");
  const orderId = placed.orderId;
  created.orderId = orderId;
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId } });
  // Give the disposable historical line an option label that differs from the current product display value.
  const purchased = await db.orderItem.update({ where: { id: line.id }, data: { optionsSnapshot: [{ name: "Colour", value: "Purchased Oat" }] } });
  const orderRequest = { read: "order", id: orderId };
  const step = (next: string, fields: object = {}) => ({ action: "order.advance", input: { orderId, next, ...fields } });

  const listing = await signed({ read: "orders", queue: "queue" }, 200, packer);
  assert.equal(listing.rows.find((row: { id: string }) => row.id === orderId).currency, "BDT");
  assert.equal((await signed({ read: "orders", queue: "all" }, 200, owner, "us")).rows.some((row: { id: string }) => row.id === orderId), false);
  const view = await signed(orderRequest, 200, packer);
  assert.equal(view.lines[0].options, "Colour Purchased Oat");
  assert.equal(view.lines[0].variantId, variantId);
  assert.equal(view.lines[0].sku, purchased.sku);
  assert.equal(view.lines[0].unitPriceMinor, purchased.unitPriceMinor);
  assert.equal(view.packable, true);
  assert.deepEqual(view.cases, []);
  await signed(orderRequest, 403, packer, "us");
  await signed(orderRequest, 404, owner, "us");
  await signed(step("PACKING"), 404, owner, "us");
  await signed(step("READY_TO_SHIP"), 422, packer);
  await signed(step("PACKING"), 200, packer);
  await signed(step("READY_TO_SHIP"), 200, packer);
  await signed(step("SHIPPED", { carrier: "Fixture courier", trackingReference: `order-${suffix}` }), 200, packer);
  await signed(step("DELIVERED"), 200, packer);
  const cash = { action: "order.collect", input: { orderId, confirmed: true } };
  await signed(cash, 403, packer);
  await signed(cash);
  assert.equal((await signed(orderRequest)).payment.status, "COLLECTED");
  assert.equal(await db.auditEvent.count({ where: { actorId: packer.id, target: orderId, action: "FULFILLMENT_CHANGED" } }), 4);

  const { id: caseId } = await executeOrderCase(buyer, { action: "open", orderId, kind: "RETURN",
    note: "The fixture parcel contains an item I want to return.", lines: [{ orderItemId: line.id, quantity: 1 }] });
  const detail = { read: "order-case", id: caseId };
  await signed(detail, 403, packer);
  await signed(detail, 404, owner, "us");
  const caseQueue = await signed({ read: "order-cases", closed: false });
  assert.equal(caseQueue.rows.some((row: { id: string }) => row.id === caseId), true);
  assert.equal((await signed(detail)).returnLines[0].options, "Colour Purchased Oat");
  const update = (fields: object) => ({ action: "order.case", input: { action: "review", caseId, revision: 0, note: "Fixture case reviewed.", ...fields } });
  await signed(update({ status: "IN_REVIEW" }), 404, owner, "us");
  await signed(update({ status: "IN_REVIEW" }));
  await signed(update({ status: "RETURN_APPROVED", revision: 1 }));
  const receive = update({ action: "receive", revision: 2, disposition: "RESTOCK", confirmed: true });
  await signed(receive);
  await signed(receive, 409);
  const after = await signed(detail);
  assert.equal(after.status, "RETURN_RECEIVED");
  assert.equal(after.returnDisposition, "RESTOCK");
  assert.equal(after.returnLines[0].unitPriceMinor, purchased.unitPriceMinor);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, original.available - 1);
  assert.deepEqual(await db.orderItem.findUniqueOrThrow({ where: { id: line.id } }), purchased);
});
