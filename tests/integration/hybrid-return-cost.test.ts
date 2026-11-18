import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { readDevAdminOrderQuery, readDevAdminOrders } from "../../src/lib/staff/dev-admin-orders.ts";
import { recordHybridReturnCost } from "../../src/lib/staff/hybrid-return-cost.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("Hybrid return cost is tied to each actual restock receipt, scoped, audited, and immutable on retry", async t => {
  const fixture = randomUUID();
  const date = new Date("2027-01-12T03:00:00.000Z");
  const operator = { id: fixture.replaceAll("-", "").slice(0, 24), name: "Fixture Cost Operator", canReturn: true, canRecordReturnCost: true };
  const actorId = "editable-admin:" + operator.id;
  const orders: string[] = [];
  const attempts: string[] = [];

  t.after(async () => {
    await db.hybridReturnCost.deleteMany({ where: {
      OR: [{ orderCase: { orderId: { in: orders } } }, { refusedOrderId: { in: orders } }],
    } });
    await db.auditEvent.deleteMany({ where: { actorId, target: { in: orders } } });
    await db.orderCase.deleteMany({ where: { orderId: { in: orders } } });
    await db.bangladeshRefusedParcelReceipt.deleteMany({ where: { orderId: { in: orders } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: orders } } });
    await db.payment.deleteMany({ where: { orderId: { in: orders } } });
    await db.order.deleteMany({ where: { id: { in: orders } } });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } });
    await db.user.deleteMany({ where: { id: actorId } });
    await db.inventory.deleteMany({ where: { variantId: fixture } });
    await db.variant.deleteMany({ where: { id: fixture } });
    await db.product.deleteMany({ where: { id: fixture } });
    await db.department.deleteMany({ where: { id: fixture } });
  });

  await db.department.create({ data: {
    id: fixture, slug: fixture, name: "Fixture", shortName: "Fixture", description: "Fixture",
    imageSrc: "/fixture.png", imageAlt: "Fixture", position: 0,
  } });
  await db.product.create({ data: {
    id: fixture, slug: fixture, departmentId: fixture, name: "Fixture", description: "Fixture",
    specifications: {}, keywords: [], addedOn: date, position: 0,
    variants: { create: { id: fixture, sku: fixture, label: "Fixture", options: {}, position: 0,
      inventory: { create: { available: 7 } } } },
  } });

  async function createOrder(eligible = true) {
    const attempt = await db.checkoutAttempt.create({ data: { id: randomUUID(), guestKey: randomUUID(), requestHash: "0".repeat(64) } });
    attempts.push(attempt.id);
    const order = await db.order.create({ data: {
      attemptId: attempt.id, reference: "RETURN-COST-" + randomUUID(), marketId: "bd", currency: "BDT", measurementTest: eligible,
      fulfillmentStatus: "DELIVERED", createdAt: date, customerName: "Synthetic", phone: "01000000001",
      locality: "Fixture", district: "dhaka", districtLabel: "Dhaka", address: "Fixture",
      deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax",
      subtotalMinor: 30000, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor: 30000,
      payment: { create: { method: "COD", status: "COLLECTED", amountMinor: 30000, currency: "BDT" } },
      items: { create: { variantId: fixture, sku: fixture, productName: "Fixture", variantName: "Fixture",
        quantity: 3, unitPriceMinor: 10000, unitDiscountMinor: 0, lineTotalMinor: 30000, currency: "BDT" } },
    }, include: { items: true } });
    orders.push(order.id);
    return order;
  }

  const order = await createOrder();
  const refused = await createOrder();
  const live = await createOrder(false);
  async function receive(disposition: "RESTOCK" | "HOLD") {
    return db.orderCase.create({ data: {
      orderId: order.id, kind: "RETURN", status: "RETURN_RECEIVED", returnReceivedAt: date, returnDisposition: disposition,
      returnLines: { create: { orderItemId: order.items[0].id, quantity: 1 } },
    } });
  }
  const first = await receive("RESTOCK");
  const second = await receive("RESTOCK");
  const held = await receive("HOLD");
  await db.bangladeshRefusedParcelReceipt.create({ data: {
    orderId: refused.id, receivedAt: date, disposition: "RESTOCK", restockedUnits: 3, note: "Fixture received parcel",
  } });
  const original = {
    COMMERCE_MODE: process.env.COMMERCE_MODE, DATABASE_URL: process.env.DATABASE_URL,
    GRIIP_MARKETPLACE_PREVIEW: process.env.GRIIP_MARKETPLACE_PREVIEW, GRIIP_HYBRID_STOREFRONT: process.env.GRIIP_HYBRID_STOREFRONT,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  };
  // The adapter was initialized against the loopback fixture. Only the signed actor's deployment predicate uses these placeholders.
  Object.assign(process.env, {
    COMMERCE_MODE: "staging", DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db:5432/griipbuddy_hybrid_demo",
    GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1", BETTER_AUTH_URL: "https://dev.griipbuddy.com",
  });
  try {
    const output = (caseId: string | undefined, amountMinor: number, evidence: string) => ({
      action: "record-return-cost", caseId, amountMinor, evidence,
    });
    const exact = output(first.id, 8750, "Lot A1 / invoice 42");
    await assert.rejects(recordHybridReturnCost({ ...operator, canRecordReturnCost: false }, order.id, exact), /Access denied/);
    await assert.rejects(recordHybridReturnCost({ ...operator, canReturn: false }, order.id, exact), /Access denied/);
    await assert.rejects(recordHybridReturnCost(operator, live.id, exact), /Order not found/);
    await assert.rejects(recordHybridReturnCost(operator, refused.id, exact), /recorded restock receipt/);
    await assert.rejects(recordHybridReturnCost(operator, order.id, output(held.id, 50, "Lot held")), /recorded restock receipt/);

    await Promise.all([recordHybridReturnCost(operator, order.id, exact), recordHybridReturnCost(operator, order.id, exact)]);
    await recordHybridReturnCost(operator, order.id, output(second.id, 6200, "Lot B1 / invoice 60"));
    await recordHybridReturnCost(operator, refused.id, output(undefined, 18550, "Lots C1 and C2"));
    await assert.rejects(recordHybridReturnCost(operator, order.id, output(first.id, 8751, exact.evidence)), /already has a recorded purchase cost/);
    assert.equal(await db.auditEvent.count({ where: { actorId, target: { in: [order.id, refused.id] } } }), 3);
    assert.equal(await db.hybridReturnCost.count({ where: { caseId: { in: [first.id, second.id] } } }), 2);
    assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: fixture } })).available, 7);

    const read = async (params: Record<string, string>) => {
      const parsed = readDevAdminOrderQuery(new URLSearchParams(params));
      assert.ok(parsed);
      return readDevAdminOrders(db, parsed);
    };
    assert.doesNotMatch(JSON.stringify(await read({ id: order.id })), /amountMinor":8750|Lot A1/);
    const detail = JSON.stringify(await read({ id: order.id, costs: "1" }));
    assert.match(detail, /amountMinor":8750,.*Lot A1/);
    assert.match(detail, /amountMinor":6200,.*Lot B1/);
    const reports = { view: "reporting", from: "2027-01-12", to: "2027-01-12" };
    assert.doesNotMatch(JSON.stringify(await read(reports)), /amountMinor":8750|amountMinor":18550/);
    const report = JSON.stringify(await read({ ...reports, costs: "1" }));
    assert.match(report, /amountMinor":8750/);
    assert.match(report, /amountMinor":18550/);
    assert.doesNotMatch(report, /Lot A1|Lots C1 and C2/);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
