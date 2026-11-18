import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { GET, POST } from "../../src/app/api/internal/dev-admin-orders/route.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { executeOrderCase } from "../../src/lib/marketplace/cases.ts";
import type { DevAdminOrderCommand } from "../../src/lib/staff/dev-admin-order-proof.ts";
import { warehouseDispatchKey } from "../../src/lib/staff/hybrid-warehouse-evidence.ts";
import { warehouseReturnKey, type WarehouseRequest } from "../../src/lib/staff/hybrid-warehouse.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("warehouse dispatch and receipts preserve purchase cost and exact-once stock through interruption", async t => {
  const suffix = randomUUID();
  const nativeOperator = suffix.replaceAll("-", "").slice(0, 24);
  const variantId = "v-" + nativeOperator;
  const operator = { id: nativeOperator, name: "Warehouse fixture", canReturn: true, assignedWarehouseId: "a".repeat(24) };
  const ownerId = "fixture-owner-" + suffix;
  const sku = "Warehouse-fixture-" + suffix;
  const scope = { warehouseId: operator.assignedWarehouseId };
  const orders: string[] = [];
  const attempts: string[] = [];
  const cases: string[] = [];
  const readToken = "2".repeat(64);
  const fulfillmentToken = "3".repeat(64);
  const ledgerToken = "4".repeat(64);
  const endpoint = "http://127.0.0.1/api/internal/dev-admin-orders";
  const headers = { Authorization: "Bearer " + readToken };
  let reject = true;
  let interrupt = true;
  const recorded = new Map<string, { request: WarehouseRequest; event: object }>();
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + ledgerToken);
    assert.equal(req.url, "/api/v1/internal/hybrid-inventory");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as WarehouseRequest;
    assert.equal(request.warehouseId, scope.warehouseId);
    if (request.action === "dispatch") {
      assert.equal(request.operatorId, nativeOperator);
      assert.equal(request.lines[0].variantId, variantId);
      assert.equal(request.lines[0].sku, sku);
    }
    if (reject) {
      reject = false;
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "Not enough warehouse stock.", writeState: "rejected" }));
      return;
    }
    const eventId = request.action === "dispatch" ? warehouseDispatchKey(request.orderId) : warehouseReturnKey(request.receiptId);
    const prior = recorded.get(eventId);
    if (prior) assert.deepEqual(request, prior.request);
    const lines = request.lines.map(({ itemId, quantity }) => ({ itemId, quantity, costMinor: quantity * 400 }));
    const data = prior?.event ?? { orderId: request.orderId, warehouseId: request.warehouseId, action: request.action, eventId,
      ...(request.action === "return" && { disposition: request.disposition }), costMinor: lines.reduce((sum, line) => sum + line.costMinor, 0),
      lines, recordedAt: new Date().toISOString() };
    recorded.set(eventId, { request, event: data });
    if (interrupt) {
      interrupt = false;
      req.socket.destroy();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise<void>((resolve, fail) => server.once("error", fail).listen(38993, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.hybridReturnCost.deleteMany({ where: { OR: [{ caseId: { in: cases } }, { refusedOrderId: { in: orders } }] } });
    await db.auditEvent.deleteMany({ where: { actorId: { in: ["editable-admin:" + nativeOperator, ownerId] } } });
    await db.orderCase.deleteMany({ where: { id: { in: cases } } });
    await db.bangladeshRefusedParcelReceipt.deleteMany({ where: { orderId: { in: orders } } });
    await db.bangladeshShipmentEvent.deleteMany({ where: { orderId: { in: orders } } });
    await db.bangladeshShipment.deleteMany({ where: { orderId: { in: orders } } });
    await db.fulfillmentEvent.deleteMany({ where: { orderId: { in: orders } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: orders } } });
    await db.payment.deleteMany({ where: { orderId: { in: orders } } });
    await db.order.deleteMany({ where: { id: { in: orders } } });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } });
    await db.staffAccess.deleteMany({ where: { userId: ownerId } });
    await db.user.deleteMany({ where: { id: { in: ["editable-admin:" + nativeOperator, ownerId] } } });
    await db.inventory.delete({ where: { variantId } });
    await db.variant.delete({ where: { id: variantId } });
    await db.product.delete({ where: { id: suffix } });
    await db.department.delete({ where: { id: suffix } });
  });

  await db.user.create({ data: { id: ownerId, name: "Native fixture", email: ownerId + "@example.test",
    staff: { create: { role: "OWNER", marketIds: ["bd"] } } } });
  await db.department.create({ data: { id: suffix, slug: suffix, name: "Fixture", shortName: "Fixture", description: "",
    imageSrc: "/fixture.png", imageAlt: "Fixture", position: 0 } });
  await db.product.create({ data: { id: suffix, slug: suffix, departmentId: suffix, name: "Fixture", description: "",
    specifications: {}, keywords: [], addedOn: new Date(), position: 0,
    variants: { create: { id: variantId, sku, label: "Fixture", options: {}, position: 0, inventory: { create: { available: 7 } } } } } });

  for (const fulfillmentStatus of ["READY_TO_SHIP", "READY_TO_SHIP", "DELIVERED"] as const) {
    const attemptId = randomUUID();
    attempts.push(attemptId);
    await db.checkoutAttempt.create({ data: { id: attemptId, guestKey: "0".repeat(64), requestHash: "1".repeat(64) } });
    const order = await db.order.create({ data: {
      attemptId, reference: suffix + "-" + attempts.length, marketId: "bd", currency: "BDT", measurementTest: true, fulfillmentStatus,
      ...(fulfillmentStatus === "DELIVERED" && { shippingWarehouseId: scope.warehouseId, shippingWarehouseName: "Fixture warehouse" }),
      customerName: "Synthetic buyer", phone: "01700009999", locality: "Fixture", district: "dhaka", districtLabel: "Dhaka", address: "Test",
      deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax", subtotalMinor: 30000, discountMinor: 0,
      deliveryMinor: 500, taxMinor: 0, totalMinor: 30500,
      payment: { create: { method: "COD", status: "AWAITING_COLLECTION", amountMinor: 30500, currency: "BDT" } },
      items: { create: { variantId, sku, productName: "Fixture", variantName: "Fixture",
        quantity: 3, unitPriceMinor: 10000, unitDiscountMinor: 0, lineTotalMinor: 30000, currency: "BDT" } },
    } });
    orders.push(order.id);
  }

  // Pin the Prisma client to the disposable database before enabling the protected stage boundaries.
  Object.assign(process.env, {
    COMMERCE_MODE: "staging", NODE_ENV: "test",
    DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db:5432/griipbuddy_hybrid_demo",
    GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1", BETTER_AUTH_URL: "https://dev.griipbuddy.com",
    GRIIP_HYBRID_ADMIN_ORDERS_TOKEN: readToken, GRIIP_HYBRID_ADMIN_FULFILLMENT_TOKEN: fulfillmentToken,
    GRIIP_HYBRID_INVENTORY_TOKEN: ledgerToken, GRIIP_HYBRID_INVENTORY_ORIGIN: "http://127.0.0.1:38993",
  });
  async function command(id: string, raw: DevAdminOrderCommand, expected = 200) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ id, operator, command: raw });
    const digest = createHmac("sha256", Buffer.from(fulfillmentToken, "hex"))
      .update("griipbuddy/hybrid-fulfillment/v1\n" + timestamp + "\n" + body).digest("hex");
    const response = await POST(new Request(endpoint, { method: "POST", body, headers: {
      ...headers, "Content-Type": "application/json", "X-Griip-Hybrid-Proof": timestamp + "." + digest,
    } }));
    assert.equal(response.status, expected, await response.text());
  }
  async function report(extra: Record<string, string> = {}) {
    const query = new URLSearchParams({ view: "reporting", locations: scope.warehouseId, ...extra });
    const response = await GET(new Request(endpoint + "?" + query, { headers }));
    assert.equal(response.status, 200);
    return (await response.json()).reportOrders;
  }
  const [delivered, refused, historical] = orders;
  const shipping = { action: "advance", next: "SHIPPED", simulate: true,
    warehouse: { id: scope.warehouseId, name: "Fixture warehouse" } } as const;
  await command(delivered, shipping, 409);
  assert.equal(await db.hybridWarehousePosting.count({ where: { orderId: delivered } }), 0);
  await command(delivered, shipping, 503);
  const pending = await db.hybridWarehousePosting.findUniqueOrThrow({ where: { key: warehouseDispatchKey(delivered) } });
  assert.equal(pending.completedAt, null);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: delivered } })).fulfillmentStatus, "READY_TO_SHIP");
  await command(delivered, { action: "cancel", confirm: true }, 409);
  await command(delivered, { ...shipping, simulate: false, carrier: "Different", trackingReference: "Unrelated" }, 409);
  await command(delivered, shipping);
  await command(delivered, shipping);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: delivered } })).trackingReference, pending.trackingReference);
  await command(delivered, { action: "track", status: "DELIVERED" });

  const deliveredItem = await db.orderItem.findFirstOrThrow({ where: { orderId: delivered } });
  async function makeReturn(disposition: "RESTOCK" | "HOLD", quantity: number) {
    const row = await db.orderCase.create({ data: { orderId: delivered, kind: "RETURN", reason: "CHANGED_MIND", status: "RETURN_APPROVED",
      returnLines: { create: { orderItemId: deliveredItem.id, quantity } } } });
    cases.push(row.id);
    return { action: "receive-return", caseId: row.id, revision: 0, confirmed: true, disposition } as const;
  }
  const received = await makeReturn("RESTOCK", 1);
  interrupt = true;
  await command(delivered, received, 503);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, 7);
  await command(delivered, { ...received, disposition: "HOLD" }, 409);
  await command(delivered, received);
  await command(delivered, received);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, 8);
  assert.equal((await db.hybridReturnCost.findUniqueOrThrow({ where: { caseId: received.caseId } })).amountMinor, 400);

  const held = await makeReturn("HOLD", 1);
  await executeOrderCase({ role: "owner", id: ownerId, market: "bd" },
    { action: "receive", caseId: held.caseId, revision: held.revision, disposition: "HOLD", confirmed: true });
  const holdMovement = recorded.get(warehouseReturnKey(held.caseId))?.request;
  assert.equal(holdMovement?.action === "return" ? holdMovement.ownerActorId : null, ownerId);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, 8);
  assert.equal(await db.hybridReturnCost.count({ where: { caseId: held.caseId } }), 0);

  await command(refused, shipping);
  await command(refused, { action: "track", status: "REFUSED" });
  const preReceipt = (await report()).find((row: { id: string }) => row.id === refused);
  assert.equal(preReceipt.warehouseUnitsPendingRestock, 3);
  await command(refused, { action: "receive", disposition: "RESTOCK", note: "Received full parcel." });
  await command(refused, { action: "receive", disposition: "RESTOCK", note: "Received full parcel." });
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, 11);
  assert.equal((await db.hybridReturnCost.findUniqueOrThrow({ where: { refusedOrderId: refused } })).amountMinor, 1200);

  const withProfit = await report({ profit: "1", warehouseSince: new Date(Date.now() - 60_000).toISOString() });
  const completed = withProfit.find((row: { id: string }) => row.id === delivered);
  assert.equal(completed.purchaseCostMinor, 1200);
  assert.equal(completed.warehouseInventoryRecorded, true);
  assert.equal(completed.warehouseStockExpected, true);
  assert.equal(typeof completed.updatedAt, "string");
  assert.deepEqual(completed.cases.map((row: { returnCost: { amountMinor: number } | null }) => row.returnCost?.amountMinor ?? 0).sort(), [0, 400]);
  assert.equal(withProfit.find((row: { id: string }) => row.id === historical).purchaseCostMinor, null);
  assert.equal((await report()).find((row: { id: string }) => row.id === delivered).purchaseCostMinor, undefined);
  assert.equal(recorded.size, 5);
});
