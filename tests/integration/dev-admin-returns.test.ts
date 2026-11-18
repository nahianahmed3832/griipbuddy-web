import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { GET, POST } from "../../src/app/api/internal/dev-admin-orders/route.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import type { DevAdminOrderCommand } from "../../src/lib/staff/dev-admin-order-proof.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("signed editable admin contact, notes and split return workflow use the same Hybrid records", async t => {
  const suffix = randomUUID();
  const warehouse = "a".repeat(24);
  const operator = { id: suffix.replaceAll("-", "").slice(0, 24), name: "Fixture Operator", canReturn: true, assignedWarehouseId: warehouse };
  const actorId = "editable-admin:" + operator.id;
  const orders: string[] = [];
  const attempts: string[] = [];
  const now = new Date();
  const endpoint = "http://127.0.0.1/api/internal/dev-admin-orders";
  const secret = "1".repeat(64);
  const readToken = "2".repeat(64);

  t.after(async () => {
    await db.auditEvent.deleteMany({ where: { actorId } });
    await db.orderCase.deleteMany({ where: { orderId: { in: orders } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: orders } } });
    await db.payment.deleteMany({ where: { orderId: { in: orders } } });
    await db.order.deleteMany({ where: { id: { in: orders } } });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } });
    await db.user.deleteMany({ where: { id: actorId } });
    await db.inventory.deleteMany({ where: { variantId: suffix } });
    await db.variant.deleteMany({ where: { id: suffix } });
    await db.product.deleteMany({ where: { id: suffix } });
    await db.department.deleteMany({ where: { id: suffix } });
  });

  await db.department.create({ data: { id: suffix, slug: suffix, name: "Fixture", shortName: "Fixture", description: "",
    imageSrc: "/fixture.png", imageAlt: "Fixture", position: 0 } });
  await db.product.create({ data: { id: suffix, slug: suffix, departmentId: suffix, name: "Fixture", description: "",
    specifications: {}, keywords: [], addedOn: now, position: 0,
    variants: { create: { id: suffix, sku: suffix, label: "Fixture", options: {}, position: 0, inventory: { create: { available: 7 } } } } } });
  for (const stage of ["UNFULFILLED", "DELIVERED"] as const) {
    const attemptId = randomUUID();
    attempts.push(attemptId);
    await db.checkoutAttempt.create({ data: { id: attemptId, guestKey: "0".repeat(64), requestHash: "1".repeat(64) } });
    const order = await db.order.create({ data: {
      attemptId, reference: stage + "-" + suffix, marketId: "bd", currency: "BDT", measurementTest: true,
      fulfillmentStatus: stage, ...(stage === "DELIVERED" && { shippingWarehouseId: warehouse, shippingWarehouseName: "Fixture warehouse" }),
      customerName: "Private Fixture", phone: "01700009999", locality: "Fixture", district: "dhaka", districtLabel: "Dhaka", address: "Before",
      deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax", subtotalMinor: 30000, discountMinor: 0,
      deliveryMinor: 500, taxMinor: 0, totalMinor: 30500,
      payment: { create: { method: "COD", status: stage === "DELIVERED" ? "COLLECTED" : "AWAITING_COLLECTION", amountMinor: 30500, currency: "BDT" } },
      items: { create: { variantId: suffix, sku: suffix, productName: "Fixture", variantName: "Fixture",
        quantity: 3, unitPriceMinor: 10000, unitDiscountMinor: 0, lineTotalMinor: 30000, currency: "BDT" } },
    } });
    orders.push(order.id);
  }

  // getDb was pinned to the loopback fixture before enabling the protected storefront mode.
  Object.assign(process.env, { COMMERCE_MODE: "staging",
    DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db:5432/griipbuddy_hybrid_demo", GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1",
    BETTER_AUTH_URL: "https://dev.griipbuddy.com", GRIIP_HYBRID_ADMIN_ORDERS_TOKEN: readToken, GRIIP_HYBRID_ADMIN_FULFILLMENT_TOKEN: secret });
  const authorization = "Bearer " + readToken;
  function proof(purpose: string, body: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return timestamp + "." + createHmac("sha256", Buffer.from(secret, "hex"))
      .update("griipbuddy/" + purpose + "/v1\n" + timestamp + "\n" + body).digest("hex");
  }
  function read(id: string, assigned = warehouse) {
    const query = new URLSearchParams({ id, ops: "1", warehouse: assigned }).toString();
    return GET(new Request(endpoint + "?" + query, { headers: { authorization, "X-Griip-Hybrid-Proof": proof("hybrid-order-details", query) } }));
  }
  function send(id: string, command: DevAdminOrderCommand, actor = operator) {
    const body = JSON.stringify({ id, operator: actor, command });
    return POST(new Request(endpoint, { method: "POST", body, headers: {
      authorization, "Content-Type": "application/json", "X-Griip-Hybrid-Proof": proof("hybrid-fulfillment", body),
    } }));
  }
  const expectStatus = async (response: Promise<Response>, status: number) => {
    const result = await response;
    assert.equal(result.status, status, status === result.status ? undefined : await result.text());
    return result;
  };
  const [packing, delivered] = orders;
  await expectStatus(GET(new Request(endpoint + "?id=" + packing + "&ops=1", { headers: { authorization } })), 404);
  const basic = await GET(new Request(endpoint + "?id=" + packing, { headers: { authorization } }));
  assert.doesNotMatch(await basic.text(), /Private Fixture|01700009999|Before/);
  const { operations } = await (await expectStatus(read(packing), 200)).json();
  await expectStatus(send(packing, { action: "edit-contact", name: "Updated Fixture", phone: "01700009998", address: "After",
    revision: operations.updatedAt }), 200);
  await expectStatus(send(packing, { action: "edit-contact", name: "Stale Fixture", phone: "01700009998", address: "After",
    revision: operations.updatedAt }), 409);
  const note = { action: "add-note", note: "Prepared by the packing desk.", key: randomUUID() } as const;
  await expectStatus(send(packing, note), 200);
  await expectStatus(send(packing, note), 200);
  const updated = (await (await read(packing)).json()).operations;
  assert.equal(updated.customerName, "Updated Fixture");
  assert.equal(updated.address, "After");
  assert.deepEqual(updated.notes.map((entry: { text: string }) => entry.text), [note.note]);
  await expectStatus(read(delivered, "b".repeat(24)), 404);

  const current = (await (await read(delivered)).json()).operations;
  const lines = [{ orderItemId: current.items[0].id, quantity: 1 }];
  const open = { action: "open-return", reason: "CHANGED_MIND", note: "Customer requested a split return.", lines } as const;
  await expectStatus(send(delivered, open, { ...operator, canReturn: false }), 403);
  await expectStatus(send(delivered, open), 200);
  await expectStatus(send(delivered, open), 409);
  const caseId: string = (await (await read(delivered)).json()).operations.cases[0].id;
  const review = { action: "review-return", caseId, revision: 0, status: "IN_REVIEW", note: "Reviewing request." } as const;
  await expectStatus(send(packing, review), 404);
  await expectStatus(send(delivered, review), 200);
  await expectStatus(send(delivered, { ...review, revision: 1, status: "RETURN_APPROVED" }), 200);
  const receipt = { action: "receive-return", caseId, revision: 2, disposition: "RESTOCK", confirmed: true } as const;
  await expectStatus(send(delivered, receipt), 200);
  await expectStatus(send(delivered, receipt), 409);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: suffix } })).available, 8);

  const refund = { action: "confirm-return-refund", caseId, revision: 3, amountMinor: 10000,
    method: "Cash test", reference: "split-" + suffix, confirmed: true } as const;
  await expectStatus(send(delivered, { ...refund, amountMinor: 10001 }), 409);
  await expectStatus(send(delivered, refund), 200);
  await expectStatus(send(delivered, refund), 200);
  await expectStatus(send(delivered, { ...review, revision: 4, status: "RESOLVED" }), 200);

  await expectStatus(send(delivered, { ...open, lines: [{ ...lines[0], quantity: 3 }] }), 409);
  await expectStatus(send(delivered, { ...open, reason: "DAMAGED", lines: [{ ...lines[0], quantity: 2 }] }), 200);
  const damaged = (await (await read(delivered)).json()).operations.cases.find((entry: { status: string }) => entry.status === "OPEN");
  await expectStatus(send(delivered, { ...review, caseId: damaged.id }), 200);
  await expectStatus(send(delivered, { ...review, caseId: damaged.id, revision: 1, status: "RETURN_APPROVED" }), 200);
  await expectStatus(send(delivered, { ...receipt, caseId: damaged.id, disposition: "HOLD" }), 200);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: suffix } })).available, 8);
  assert.equal((await db.orderCase.findUniqueOrThrow({ where: { id: caseId } })).refundAmountMinor, 10000);
});
