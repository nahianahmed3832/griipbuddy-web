import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { createPayPalCheckout, paypalQuote, recoverPayPalCheckout } from "../../src/lib/commerce/paypal-checkout.ts";
import { refundPayPalOrder } from "../../src/lib/commerce/paypal-refund.ts";
import { verifySandboxWebhook } from "../../src/lib/commerce/paypal-provider.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { commerceOutcomeSelect, failedPaymentAttempts, projectCommerceOutcomes } from "../../src/lib/measurement/outcomes.ts";
import { advanceFulfillment } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR = "699";
process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_ID = "test-client";
process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_SECRET = "test-secret";
process.env.MARKETPLACE_PAYPAL_SANDBOX_WEBHOOK_ID = "test-webhook";

const db = getDb();
after(() => db.$disconnect());

async function exerciseUsCheckout(t: TestContext, useLocation: boolean) {
  const suffix = randomBytes(4).toString("hex");
  const productId = `pay-test-${suffix}`;
  const variantId = `v-pay-test-${suffix}`;
  const staffId = `mock-staff-${suffix}`;
  const locationId = `us-warehouse-${suffix}`;
  const department = await db.department.findFirstOrThrow();
  const attempts = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const guestKey = randomBytes(32).toString("hex");
  type MockOrder = { id: string; status: string; purchase_units: Record<string, unknown>[]; links: { href: string; rel: string }[] };
  const orders = new Map<string, MockOrder>();
  let creates = 0;
  let captures = 0;
  let refunds = 0;
  let refundStatus = "PENDING";

  const provider = t.mock.method(globalThis, "fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(request));
    assert.equal(url.origin, "https://api-m.sandbox.paypal.com");
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
    if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "mock-access", expires_in: 1000 });
    if (url.pathname === "/v1/notifications/verify-webhook-signature") {
      assert.equal(body.webhook_id, "test-webhook");
      return Response.json({ verification_status: body.transmission_sig === "valid-mock-signature" ? "SUCCESS" : "FAILURE" });
    }
    if (url.pathname.endsWith("/refund") || url.pathname === "/v2/payments/refunds/REFUNDONE") {
      if (url.pathname.endsWith("/refund")) refunds++;
      return Response.json({ id: "REFUNDONE", status: refundStatus, amount: { currency_code: "USD", value: "21.99" } });
    }
    if (url.pathname === "/v2/checkout/orders" && init?.method === "POST") {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("PayPal-Request-Id"), body.purchase_units[0].reference_id);
      assert.equal(body.payment_source.paypal.experience_context.shipping_preference, "SET_PROVIDED_ADDRESS");
      assert.equal(body.purchase_units[0].shipping.address.country_code, "US");
      assert.equal(body.purchase_units[0].amount.value, "21.99");
      const id = `PAYORDER${++creates}`;
      const order = { id, status: "APPROVED", purchase_units: body.purchase_units,
        links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] };
      orders.set(id, order);
      return Response.json(order);
    }
    const id = url.pathname.split("/")[4];
    const order = orders.get(id);
    assert.ok(order);
    if (url.pathname.endsWith("/capture")) {
      captures++;
      assert.ok(new Headers(init?.headers).has("PayPal-Request-Id"));
      if (order.purchase_units[0].reference_id === attempts[4]) {
        order.purchase_units[0].payments = { captures: [{ id: "DECLINEDONE", status: "DECLINED", amount: { currency_code: "USD", value: "21.99" } }] };
        return Response.json(order);
      }
      order.status = "COMPLETED";
      order.purchase_units[0].payments = { captures: [{ id: "CAPTUREONE", status: "COMPLETED", amount: { currency_code: "USD", value: "21.99" } }] };
      throw new Error("simulate connection loss after provider captured");
    }
    return Response.json(order);
  });

  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: department.id, name: "US sandbox test case",
    description: "Dedicated fixture", keywords: [], specifications: {}, position: 9999, addedOn: new Date(), publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId, label: "Black", position: 0, options: {},
      inventory: { create: { available: useLocation ? 0 : 3 } }, offers: { create: { marketId: "us", currency: "USD", amountMinor: 1500 } } } },
  } });
  await db.user.create({ data: {
    id: staffId, name: "Mock owner", email: `${staffId}@example.invalid`, staff: { create: { role: "OWNER" } },
  } });
  const input = { items: [{ variantId, quantity: 1 }], customer: {
    country: "US", name: "Sandbox buyer", addressLine1: "100 Test Street", city: "Seattle",
    state: "WA", postalCode: "98101", phone: "206-555-0123",
  } };
  const stock = async () => useLocation
    ? (await db.locationInventory.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } })).available
    : (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;

  try {
    if (useLocation) {
      await db.dispatchLocation.create({ data: { id: locationId, name: "US test warehouse", marketId: "us" } });
      await db.locationInventory.create({ data: { locationId, variantId, available: 3 } });
    }
    await assert.rejects(paypalQuote({ ...input, customer: { ...input.customer, country: "BD" } }, guestKey), /checkout|Shipping|Check/);
    await assert.rejects(paypalQuote({ ...input, customer: { ...input.customer, state: "AK" } }, guestKey), /contiguous/);
    const quote = await paypalQuote(input, guestKey);
    assert.equal(quote.kind, "quoted");
    assert.equal(quote.quote.totalMinor, 2199);
    assert.equal((await createPayPalCheckout(input, attempts[0], "f".repeat(64), guestKey)).kind, "conflict");
    assert.equal(creates, 0);

    const canceled = await createPayPalCheckout(input, attempts[0], quote.quote.quoteToken, guestKey);
    assert.equal(canceled.kind, "approval_required");
    assert.equal(await stock(), 3);
    assert.equal((await recoverPayPalCheckout(attempts[0], guestKey, "cancel")).kind, "abandoned");
    assert.equal(await stock(), 3);

    const changed = await createPayPalCheckout(input, attempts[1], quote.quote.quoteToken, guestKey);
    assert.equal(changed.kind, "approval_required");
    await db.marketOffer.update({ where: { variantId_marketId: { variantId, marketId: "us" } }, data: { amountMinor: 1599 } });
    assert.equal((await recoverPayPalCheckout(attempts[1], guestKey, "capture")).kind, "abandoned");
    assert.equal(captures, 0);
    assert.equal(await stock(), 3);
    await db.marketOffer.update({ where: { variantId_marketId: { variantId, marketId: "us" } }, data: { amountMinor: 1500 } });

    const captured = await createPayPalCheckout(input, attempts[2], quote.quote.quoteToken, guestKey);
    assert.equal(captured.kind, "approval_required");
    assert.equal((await recoverPayPalCheckout(attempts[2], "wrong-guest", "capture")).kind, "abandoned");
    await assert.rejects(recoverPayPalCheckout(attempts[2], guestKey, "capture"), /simulate connection loss/);
    assert.equal(await stock(), 2);
    assert.equal(await db.order.count({ where: { attemptId: attempts[2] } }), 0);
    if (useLocation) {
      const held = await db.payPalCheckout.findUniqueOrThrow({ where: { attemptId: attempts[2] } });
      assert.deepEqual(held.stockAllocations, [{ variantId, quantity: 1, personalization: "", locationId, locationName: "US test warehouse" }]);
    }
    const recovered = await Promise.all([
      recoverPayPalCheckout(attempts[2], guestKey, "recover"),
      recoverPayPalCheckout(attempts[2], guestKey, "capture"),
    ]);
    assert.deepEqual(recovered[0], recovered[1]);
    assert.equal(recovered[0].kind, "placed");
    const orderId = recovered[0].orderId;
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true, parcels: true } });
    assert.equal(order.payment?.method, "PAYPAL");
    assert.equal(order.payment?.status, "PAID");
    assert.equal(order.measurementTest, true);
    assert.equal(order.totalMinor, 2199);
    assert.deepEqual(order.parcels.map(parcel => [parcel.locationId, parcel.status]), useLocation ? [[locationId, "PLANNED"]] : []);
    assert.equal(captures, 1);

    assert.equal(await refundPayPalOrder(staffId, orderId), "pending");
    await assert.rejects(advanceFulfillment(staffId, orderId, { next: "PACKING" }), /refund is pending/);
    assert.equal(await stock(), 2);
    refundStatus = "COMPLETED";
    assert.deepEqual(await Promise.all([refundPayPalOrder(staffId, orderId), refundPayPalOrder(staffId, orderId)]), ["refunded", "refunded"]);
    assert.equal(refunds, 1);
    assert.equal(await stock(), 3);
    if (useLocation) assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, 0);
    const refunded = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true, events: true } });
    assert.equal(refunded.status, "CANCELLED");
    assert.equal(refunded.payment?.status, "REFUNDED");
    assert.equal(refunded.events.filter(event => event.type === "ORDER_CANCELLED").length, 1);
    const commerceOrder = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: commerceOutcomeSelect });
    const confirmed = projectCommerceOutcomes(commerceOrder, new Date());
    assert.deepEqual(confirmed.map(event => [event.kind, event.amountMinor]), [
      ["ORDER_ACCEPTED", 2199], ["ORDER_CANCELLED", null], ["PAYMENT_PAID", 2199], ["ORDER_REFUNDED", 2199],
    ]);
    assert.equal(new Set(confirmed.map(event => event.transactionId)).size, 1);

    const failuresFrom = new Date();
    assert.equal((await createPayPalCheckout(input, attempts[4], quote.quote.quoteToken, guestKey)).kind, "approval_required");
    assert.equal((await recoverPayPalCheckout(attempts[4], guestKey, "capture")).kind, "abandoned");
    assert.equal((await recoverPayPalCheckout(attempts[4], guestKey, "capture")).kind, "abandoned");
    assert.equal(await stock(), 3);
    const failureFilter = { marketId: "us" as const, fromAt: failuresFrom, until: new Date(Date.now() + 100), take: 50 };
    const failures = await failedPaymentAttempts(db, { ...failureFilter, test: true });
    assert.deepEqual(failures.map(event => [event.kind, event.paymentMethod, event.failureCode, event.orderId]), [
      ["PAYMENT_FAILED", "PAYPAL", "DECLINED", null],
    ]);
    assert.deepEqual(await failedPaymentAttempts(db, { ...failureFilter, test: false }), []);

    assert.equal((await recoverPayPalCheckout(attempts[3], guestKey, "recover")).kind, "abandoned");
    assert.equal((await createPayPalCheckout(input, attempts[3], quote.quote.quoteToken, guestKey)).kind, "conflict");
    const headers = new Headers({
      "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://example.invalid/unused",
      "paypal-transmission-id": "mock", "paypal-transmission-sig": "invalid", "paypal-transmission-time": new Date().toISOString(),
    });
    assert.equal(await verifySandboxWebhook({ event_type: "test" }, headers), false);
    headers.set("paypal-transmission-sig", "valid-mock-signature");
    assert.equal(await verifySandboxWebhook({ event_type: "test" }, headers), true);
    assert.ok(provider.mock.callCount() > 0);
  } finally {
    const saved = await db.order.findMany({ where: { attemptId: { in: attempts } }, select: { id: true } });
    const orderIds = saved.map(({ id }) => id);
    await db.$transaction([
      db.orderParcel.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.auditEvent.deleteMany({ where: { target: { in: orderIds } } }),
      db.fulfillmentEvent.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.payment.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.order.deleteMany({ where: { id: { in: orderIds } } }),
      db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } }),
      db.user.delete({ where: { id: staffId } }),
      db.marketOffer.deleteMany({ where: { variantId } }),
      db.locationInventory.deleteMany({ where: { locationId, variantId } }),
      db.dispatchLocation.deleteMany({ where: { id: locationId } }),
      db.inventory.delete({ where: { variantId } }),
      db.variant.delete({ where: { id: variantId } }),
      db.product.delete({ where: { id: productId } }),
    ]);
  }
}

test("US checkout verifies the destination and amount, reconciles lost captures, and restores shared stock once after refund", t => exerciseUsCheckout(t, false));
test("US payment recovery keeps the original dispatch location and restores that stock after refund", t => exerciseUsCheckout(t, true));
