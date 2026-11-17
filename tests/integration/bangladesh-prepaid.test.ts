import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { acceptPrepaidCallback, recoverPrepaid, reviewPrepaid, startPrepaid } from "../../src/lib/commerce/prepaid-checkout.ts";
import { reviewCheckout } from "../../src/lib/commerce/orders.ts";
import { listStaffOrders } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.MARKETPLACE_SSLCOMMERZ_STORE_ID = "test-fixture";
process.env.MARKETPLACE_SSLCOMMERZ_STORE_PASSWORD = "test-fixture";

const db = getDb();
after(() => db.$disconnect());

test("Bangladesh prepaid prices the extra discount, verifies payment before packing, and releases canceled stock once", async t => {
  const suffix = randomBytes(4).toString("hex");
  const productId = `bd-prepaid-${suffix}`;
  const variantId = `v-${productId}`;
  const staffId = `bd-packer-${suffix}`;
  const couponCode = `SSLPREPAID-${suffix.toUpperCase()}`;
  const guestKey = randomBytes(32).toString("hex");
  const department = await db.department.findFirstOrThrow();
  const zone = await db.deliveryZone.findFirstOrThrow({
    where: { marketId: "bd", enabled: true, codEligible: true, chargeMinor: { not: null } },
  });
  const initialPayment = { status: "PENDING", value: "" };
  const gateway = new Map<string, typeof initialPayment>();
  let gatewayCalls = 0;
  const provider = t.mock.method(globalThis, "fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    assert.equal(url.origin, "https://sandbox.sslcommerz.com");
    if (init?.method === "POST") {
      assert.ok(init.body instanceof URLSearchParams);
      const body = init.body;
      assert.equal(body.get("currency"), "BDT");
      assert.equal(body.get("cus_name"), "GriipBuddy Test Customer");
      assert.notEqual(body.get("cus_addr1"), "Private sample address");
      const id = body.get("tran_id");
      assert.ok(id);
      gatewayCalls++;
      gateway.set(id, { ...initialPayment, value: body.get("total_amount") ?? "" });
      return Response.json({ status: "SUCCESS", GatewayPageURL: `https://sandbox.sslcommerz.com/gw/test?session=${id}` });
    }
    const id = url.searchParams.get("tran_id") ?? url.searchParams.get("val_id");
    const transaction = id ? gateway.get(id) : undefined;
    const record = transaction && {
      status: transaction.status, tran_id: id, val_id: id, amount: transaction.value,
      currency: "BDT", currency_type: "BDT", risk_level: "0", bank_tran_id: `BANK${id}`,
    };
    if (url.pathname.endsWith("validationserverAPI.php")) return Response.json(record);
    return Response.json({ APIConnect: "DONE", element: record ? [record] : [] });
  });

  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: department.id, name: "Bangladesh sandbox checkout case",
    description: "Dedicated test fixture", keywords: [], specifications: {}, position: 9999, addedOn: new Date(), publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId, label: "Black", position: 0, options: {},
      inventory: { create: { available: 3 } }, offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 2_000 } } } },
  } });
  await db.user.create({ data: {
    id: staffId, name: "Test packer", email: `${staffId}@example.invalid`, staff: { create: { role: "PACKER" } },
  } });
  await db.marketplaceCoupon.create({ data: { code: couponCode, kind: "PERCENT", value: 1000, minimumMinor: 0, useLimit: 1, enabled: true } });
  const body = {
    marketId: "bd", paymentMethod: "SSLCOMMERZ", deliveryMethod: zone.method, couponCode, items: [{ variantId, quantity: 1 }],
    customer: { country: "BD", name: "A Demo Shopper", phone: "01700000000", email: "demo@example.invalid", 
      district: zone.district, locality: "Test area", address: "Private sample address" },
  };
  const stock = async () => (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
  const place = async (checkout: object) => {
    const review = await reviewPrepaid(checkout, guestKey);
    assert.equal(review.kind, "review");
    const input = { ...checkout, attemptId: review.attemptId, reviewToken: review.quote.reviewToken };
    return { review, input };
  };
  try {
    const cod = await reviewCheckout({ ...body, paymentMethod: "COD" }, "bd", guestKey);
    assert.equal(cod.kind, "review");
    assert.equal(cod.quote.totalMinor > cod.quote.deliveryMinor, true);
    assert.equal(cod.quote.prepaidDiscountMinor, undefined);
    assert.equal((await reviewCheckout(body, "bd", guestKey)).kind, "invalid");

    const { review, input } = await place(body);
    assert.equal(review.quote.couponDiscountMinor, 200);
    assert.equal(review.quote.prepaidDiscountMinor, 90);
    assert.equal(review.quote.lines[0].lineTotalMinor, 1_710);
    const first = await startPrepaid(input, guestKey, false);
    const repeated = await startPrepaid(input, guestKey, false);
    assert.deepEqual(first, repeated);
    assert.equal(first.kind, "continue");
    assert.equal(gatewayCalls, 1);
    assert.equal(await stock(), 2);
    assert.equal(await db.order.count({ where: { attemptId: review.attemptId } }), 0);
    assert.equal((await reviewCheckout({ ...body, paymentMethod: "COD" }, "bd", guestKey)).kind, "unavailable");
    const session = await db.prepaidCheckout.findUniqueOrThrow({ where: { attemptId: review.attemptId } });
    assert.ok(!((await listStaffOrders(staffId, "queue", 1)).rows.some(row => row.id === session.attemptId)));
    assert.equal((await recoverPrepaid(review.attemptId, "wrong-guest")).kind, "abandoned");
    assert.equal((await recoverPrepaid(review.attemptId, guestKey)).kind, "pending");

    gateway.set(session.providerId, { status: "VALID", value: "10.00" });
    assert.equal(await acceptPrepaidCallback(session.providerId, session.providerId), review.attemptId);
    assert.equal(await db.order.count({ where: { attemptId: review.attemptId } }), 0);
    gateway.set(session.providerId, { status: "VALIDATED", value: (review.quote.totalMinor / 100).toFixed(2) });
    const [paid, duplicate] = await Promise.all([recoverPrepaid(review.attemptId, guestKey), recoverPrepaid(review.attemptId, guestKey)]);
    assert.equal(paid.kind, "placed");
    assert.deepEqual(paid, duplicate);
    const order = await db.order.findUniqueOrThrow({ where: { id: paid.orderId }, include: { payment: true } });
    assert.equal(order.payment?.method, "SSLCOMMERZ");
    assert.equal(order.payment?.status, "PAID");
    assert.equal(order.prepaidDiscountMinor, 90);
    assert.equal(await stock(), 2);
    assert.ok((await listStaffOrders(staffId, "queue", 1)).rows.some(row => row.id === paid.orderId));

    const next = await place({ ...body, couponCode: undefined });
    assert.equal((await startPrepaid(next.input, guestKey, false)).kind, "continue");
    assert.equal(await stock(), 1);
    const cancelled = await db.prepaidCheckout.findUniqueOrThrow({ where: { attemptId: next.review.attemptId } });
    gateway.set(cancelled.providerId, { status: "CANCELLED", value: "" });
    await Promise.all([recoverPrepaid(next.review.attemptId, guestKey), recoverPrepaid(next.review.attemptId, guestKey)]);
    assert.equal(await stock(), 2);
    assert.equal(await db.order.count({ where: { attemptId: next.review.attemptId } }), 0);
    assert.ok(provider.mock.callCount() >= 7);
  } finally {
    const attempts = (await db.checkoutAttempt.findMany({ where: { guestKey }, select: { id: true } })).map(row => row.id);
    const orders = (await db.order.findMany({ where: { attemptId: { in: attempts } }, select: { id: true } })).map(row => row.id);
    await db.$transaction([
      db.fulfillmentEvent.deleteMany({ where: { orderId: { in: orders } } }),
      db.payment.deleteMany({ where: { orderId: { in: orders } } }),
      db.orderItem.deleteMany({ where: { orderId: { in: orders } } }),
      db.order.deleteMany({ where: { id: { in: orders } } }),
      db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } }),
      db.marketplaceCoupon.delete({ where: { code: couponCode } }),
      db.user.delete({ where: { id: staffId } }),
      db.marketOffer.deleteMany({ where: { variantId } }),
      db.inventory.delete({ where: { variantId } }),
      db.variant.delete({ where: { id: variantId } }),
      db.product.delete({ where: { id: productId } }),
    ]);
  }
});
