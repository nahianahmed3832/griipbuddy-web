import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { readDevAdminOrderQuery, readDevAdminOrders } from "../../src/lib/staff/dev-admin-orders.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("the stored order projection includes only first-party BD test orders and preserves pages with a tied date", async t => {
  const prefix = "PROJECTION-" + randomBytes(5).toString("hex");
  const departmentId = prefix + "-department";
  const productId = prefix + "-product";
  const variants = [prefix + "-a", prefix + "-b"];
  const attempts: string[] = [];
  const partner = randomUUID();
  const createdAt = new Date("2026-11-17T13:07:00.000Z");
  t.after(async () => {
    const order = { reference: { startsWith: prefix } };
    await db.orderItem.deleteMany({ where: { order } });
    await db.payment.deleteMany({ where: { order } });
    await db.order.deleteMany({ where: order });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } });
    await db.variant.deleteMany({ where: { productId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.department.deleteMany({ where: { id: departmentId } });
  });
  await db.department.create({ data: {
    id: departmentId, slug: departmentId, name: "Projection catalogue", shortName: "Projection", description: "Fixture",
    imageSrc: "/fixture.png", imageAlt: "Fixture", position: 0,
  } });
  await db.product.create({ data: {
    id: productId, slug: productId, departmentId, name: "Test item", description: "Fixture", specifications: {}, keywords: [],
    addedOn: createdAt, position: 0, variants: { create: variants.map((id, position) => ({ id, sku: id, options: {}, label: "Fixture", position })) },
  } });

  async function order(suffix: string, shops: (string | null)[], measurementTest: boolean | null = true, marketId: "bd" | "us" = "bd") {
    const attemptId = randomUUID();
    attempts.push(attemptId);
    await db.checkoutAttempt.create({ data: { id: attemptId, guestKey: randomBytes(32).toString("hex"), requestHash: "0".repeat(64) } });
    const currency = marketId === "bd" ? "BDT" : "USD";
    return db.order.create({ data: {
      attemptId, reference: prefix + suffix, marketId, currency, measurementTest, createdAt,
      customerName: "Private name", phone: "01700000000", email: "private@example.invalid", district: "dhaka", districtLabel: "Dhaka",
      locality: "Test", address: "Private address", deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax",
      subtotalMinor: 1000, discountMinor: 0, deliveryMinor: 500, taxMinor: 0, totalMinor: 1500,
      payment: { create: { method: "COD", status: "AWAITING_COLLECTION", amountMinor: 1500, currency } },
      items: { create: shops.map((marketplaceShopId, index) => ({
        variantId: variants[index], marketplaceShopId, productName: "Test item", sku: variants[index], variantName: "Fixture",
        quantity: 1, unitPriceMinor: 1000, unitDiscountMinor: 0, lineTotalMinor: 1000, currency, personalization: "Private engraving",
      })) },
    }, select: { id: true, reference: true } });
  }

  const direct = await order("-direct", [null]);
  const store = await order("-store", [storeShop.id]);
  const hybrid = await order("-mixed", [null, partner]);
  const seller = await order("-seller", [partner]);
  const live = await order("-live", [null], false);
  const previous = await order("-unknown", [storeShop.id], null);
  const otherRegion = await order("-us", [storeShop.id], true, "us");
  const empty = await order("-empty", []);
  const expected = [direct.id, store.id].sort().reverse();

  async function query(params: Record<string, string>) {
    const parsed = readDevAdminOrderQuery(new URLSearchParams(params));
    assert.ok(parsed);
    return readDevAdminOrders(db, parsed);
  }
  const first = await query({ limit: "1", search: prefix });
  assert.ok(first?.orders && first.nextCursor);
  assert.deepEqual(first.orders.map(row => row.id), [expected[0]]);
  const second = await query({ search: prefix, after: first.nextCursor });
  assert.ok(second?.orders);
  assert.deepEqual(second.orders.map(row => row.id), [expected[1]]);
  assert.equal(second.nextCursor, null);
  for (const hidden of [hybrid, seller, live, previous, otherRegion, empty]) assert.equal(await query({ id: hidden.id }), null);

  const result = await query({ id: direct.id });
  assert.ok(result && "items" in result);
  assert.deepEqual(result.items, [{ productName: "Test item", sku: variants[0], variantName: "Fixture", quantity: 1,
    unitPriceMinor: 1000, unitDiscountMinor: 0, lineTotalMinor: 1000 }]);
  assert.equal(result.totalMinor, 1500);
  assert.deepEqual(result.payment, { method: "COD", status: "AWAITING_COLLECTION" });
  assert.doesNotMatch(JSON.stringify(result), /Private|private@example|01700000000/);
});
