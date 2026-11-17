import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { POST as paypalWebhook } from "../../src/app/api/checkout/paypal/webhook/route.ts";
import { guestOrder, visibleOrderMarket } from "../../src/lib/commerce/orders.ts";
import { createPayPalCheckout, paypalQuote, recoverPayPalCheckout } from "../../src/lib/commerce/paypal-checkout.ts";
import { refundPayPalOrder } from "../../src/lib/commerce/paypal-refund.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { shopperOrders } from "../../src/lib/marketplace/data.ts";
import { advanceFulfillment, listStaffOrders, staffOrder } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR = "699";
process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_ID = "test-client";
process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_SECRET = "test-secret";
process.env.MARKETPLACE_PAYPAL_SANDBOX_WEBHOOK_ID = "test-webhook";

const db = getDb();
after(() => db.$disconnect());

test("US PayPal checkout, scoped history, fulfillment and refunds use the same purchase and reconcile callbacks once", async t => {
  const suffix = randomBytes(4).toString("hex");
  const productId = `pay-test-${suffix}`;
  const variantId = `v-pay-test-${suffix}`;
  const staffId = `mock-staff-${suffix}`;
  const usPackerId = `mock-us-packer-${suffix}`;
  const bdPackerId = `mock-bd-packer-${suffix}`;
  const shopperId = `mock-us-shopper-${suffix}`;
  const outsiderId = `mock-us-outsider-${suffix}`;
  const department = await db.department.findFirstOrThrow();
  const attempts = Array.from({ length: 6 }, () => randomUUID());
  const guestKey = randomBytes(32).toString("hex");
  type MockOrder = { id: string; status: string; purchase_units: Record<string, unknown>[]; links: { href: string; rel: string }[] };
  const orders = new Map<string, MockOrder>();
  let creates = 0;
  let captures = 0;
  let refunds = 0;
  let refundStatus = "PENDING";
  let nextCapture: "lost" | "pending" | "declined" = "lost";

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
      order.status = "COMPLETED";
      const status = { lost: "COMPLETED", pending: "PENDING", declined: "DECLINED" }[nextCapture];
      order.purchase_units[0].payments = { captures: [{ id: `CAPTURE-${id}`, status, amount: { currency_code: "USD", value: "21.99" } }] };
      if (nextCapture === "lost") throw new Error("simulate connection loss after provider captured");
    }
    return Response.json(order);
  });

  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: department.id, name: "US sandbox test case",
    description: "Dedicated fixture", keywords: [], specifications: {}, position: 9999, addedOn: new Date(), publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId, label: "Black", position: 0, options: {},
      inventory: { create: { available: 3 } }, offers: { create: { marketId: "us", currency: "USD", amountMinor: 1600,
        discountMinor: 100, discountStartsAt: new Date(Date.now() - 60_000), discountEndsAt: new Date(Date.now() + 60 * 60_000) } } } },
  } });
  const staffGrants = [
    [staffId, "US owner", "OWNER", "us"],
    [usPackerId, "US packer", "PACKER", "us"],
    [bdPackerId, "Bangladesh packer", "PACKER", "bd"],
  ] as const;
  await db.$transaction(staffGrants.map(([id, name, role, market]) => db.user.create({ data: {
    id, name, email: `${id}@example.invalid`, staff: { create: { role, marketIds: [market] } },
  } })));
  await db.shopper.createMany({ data: [shopperId, outsiderId].map(id => ({
    id, name: "Synthetic shopper", email: `${id}@example.invalid`, emailVerified: true,
  })) });
  const input = { items: [{ variantId, quantity: 1 }], customer: {
    country: "US", name: "Sandbox buyer", addressLine1: "100 Test Street", city: "Seattle",
    state: "WA", postalCode: "98101", phone: "206-555-0123", email: `${shopperId}@example.invalid`,
  } };
  const stock = async () => (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
  const webhook = (eventType: string, resource: object, valid = true) => paypalWebhook(new Request(
    "http://127.0.0.1:3100/api/checkout/paypal/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json", "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://example.invalid/unused",
        "paypal-transmission-id": "mock", "paypal-transmission-sig": valid ? "valid-mock-signature" : "invalid",
        "paypal-transmission-time": new Date().toISOString(),
      },
      body: JSON.stringify({ event_type: eventType, resource }),
    },
  ));
  const captureResource = (providerId: string) => ({ supplementary_data: { related_ids: { order_id: providerId } } });
  async function providerOrderId(attemptId: string) {
    const session = await db.payPalCheckout.findUniqueOrThrow({ where: { attemptId }, select: { providerOrderId: true } });
    assert.ok(session.providerOrderId);
    return session.providerOrderId;
  }

  try {
    await assert.rejects(paypalQuote({ ...input, customer: { ...input.customer, country: "BD" } }, guestKey), /checkout|Shipping|Check/);
    await assert.rejects(paypalQuote({ ...input, customer: { ...input.customer, state: "AK" } }, guestKey), /contiguous/);
    const quote = await paypalQuote(input, guestKey);
    assert.equal(quote.kind, "quoted");
    assert.equal(quote.quote.subtotalMinor, 1600);
    assert.equal(quote.quote.discountMinor, 100);
    assert.equal(quote.quote.merchandiseSubtotalMinor, 1500);
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
    await db.marketOffer.update({ where: { variantId_marketId: { variantId, marketId: "us" } }, data: { amountMinor: 1699 } });
    assert.equal((await recoverPayPalCheckout(attempts[1], guestKey, "capture")).kind, "abandoned");
    assert.equal(captures, 0);
    assert.equal(await stock(), 3);
    await db.marketOffer.update({ where: { variantId_marketId: { variantId, marketId: "us" } }, data: { amountMinor: 1600 } });

    const captured = await createPayPalCheckout(input, attempts[2], quote.quote.quoteToken, guestKey, shopperId);
    assert.equal(captured.kind, "approval_required");
    assert.equal((await recoverPayPalCheckout(attempts[2], "wrong-guest", "capture")).kind, "abandoned");
    await assert.rejects(recoverPayPalCheckout(attempts[2], guestKey, "capture"), /simulate connection loss/);
    assert.equal(await stock(), 2);
    assert.equal(await db.order.count({ where: { attemptId: attempts[2] } }), 0);
    const captureEvent = captureResource(await providerOrderId(attempts[2]));
    assert.equal((await webhook("PAYMENT.CAPTURE.COMPLETED", captureEvent, false)).status, 403);
    assert.equal(await db.order.count({ where: { attemptId: attempts[2] } }), 0);
    const recovered = await Promise.all([
      recoverPayPalCheckout(attempts[2], guestKey, "recover"),
      recoverPayPalCheckout(attempts[2], guestKey, "capture"),
    ]);
    assert.equal((await webhook("PAYMENT.CAPTURE.COMPLETED", captureEvent)).status, 204);
    assert.deepEqual(recovered[0], recovered[1]);
    assert.equal(recovered[0].kind, "placed");
    const orderId = recovered[0].orderId;
    assert.equal(await db.order.count({ where: { attemptId: attempts[2] } }), 1);
    const history = await shopperOrders(shopperId, null, "us");
    assert.equal(history.length, 1);
    assert.equal(history[0].id, orderId);
    assert.equal(history[0].currency, "USD");
    assert.deepEqual(await shopperOrders(shopperId, guestKey, "bd"), []);
    assert.deepEqual(await shopperOrders(outsiderId, guestKey, "us"), []);
    assert.equal(await guestOrder(orderId, guestKey, outsiderId, "us"), null);
    assert.equal(await guestOrder(orderId, null, shopperId, "bd"), null);
    assert.deepEqual(await visibleOrderMarket(orderId, null, shopperId), { marketId: "us" });
    const order = await guestOrder(orderId, null, shopperId, "us");
    assert.ok(order);
    assert.equal(order.payment?.method, "PAYPAL");
    assert.equal(order.payment?.status, "PAID");
    assert.equal(order.measurementTest, true);
    assert.equal(order.address, input.customer.addressLine1);
    assert.equal(order.currency, "USD");
    assert.equal(order.totalMinor, 2199);
    assert.ok(order.returnTerms && typeof order.returnTerms === "object" && "version" in order.returnTerms);
    assert.equal(order.returnTerms.version, "us-paypal-preview-v1");
    assert.equal(captures, 1);
    assert.ok((await listStaffOrders(usPackerId, "queue", 1)).rows.some(row => row.id === orderId));
    assert.equal((await listStaffOrders(bdPackerId, "queue", 1)).rows.some(row => row.id === orderId), false);
    assert.equal(await staffOrder(bdPackerId, orderId), null);
    await assert.rejects(advanceFulfillment(bdPackerId, orderId, { next: "PACKING" }), /Order not found/);
    await advanceFulfillment(usPackerId, orderId, { next: "PACKING" });
    assert.equal((await guestOrder(orderId, null, shopperId, "us"))?.fulfillmentStatus, "PACKING");

    await assert.rejects(refundPayPalOrder(usPackerId, orderId), /permission/);
    assert.equal(await refundPayPalOrder(staffId, orderId), "pending");
    assert.equal((await guestOrder(orderId, null, shopperId, "us"))?.payment?.status, "REFUND_PENDING");
    await assert.rejects(advanceFulfillment(staffId, orderId, { next: "READY_TO_SHIP" }), /refund is pending/);
    assert.equal(await stock(), 2);
    refundStatus = "COMPLETED";
    const refundEvent = { id: "REFUNDONE" };
    const callbacks = await Promise.all([
      webhook("PAYMENT.REFUND.COMPLETED", refundEvent),
      webhook("PAYMENT.REFUND.COMPLETED", refundEvent),
    ]);
    assert.deepEqual(callbacks.map(response => response.status), [204, 204]);
    assert.deepEqual(await Promise.all([refundPayPalOrder(staffId, orderId), refundPayPalOrder(staffId, orderId)]), ["refunded", "refunded"]);
    assert.equal(refunds, 1);
    assert.equal(await stock(), 3);
    const refunded = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true, events: true } });
    assert.equal(refunded.status, "CANCELLED");
    assert.equal(refunded.payment?.status, "REFUNDED");
    assert.equal(refunded.payment?.amountMinor, 2199);
    assert.equal(refunded.payment?.currency, "USD");
    assert.deepEqual(refunded.returnTerms, order.returnTerms);
    assert.equal(refunded.events.filter(event => event.type === "ORDER_CANCELLED").length, 1);

    nextCapture = "declined";
    assert.equal((await createPayPalCheckout(input, attempts[3], quote.quote.quoteToken, guestKey, shopperId)).kind, "approval_required");
    const declined = await recoverPayPalCheckout(attempts[3], guestKey, "capture");
    assert.equal(declined.kind, "abandoned");
    assert.match(declined.message, /declined the payment/);
    assert.equal(await stock(), 3);
    assert.equal(await db.order.count({ where: { attemptId: attempts[3] } }), 0);

    nextCapture = "pending";
    assert.equal((await createPayPalCheckout(input, attempts[4], quote.quote.quoteToken, guestKey, shopperId)).kind, "approval_required");
    const pending = await recoverPayPalCheckout(attempts[4], guestKey, "capture");
    assert.equal(pending.kind, "pending");
    assert.match(pending.message, /hasn’t confirmed this payment yet/);
    assert.equal(await stock(), 2);
    assert.equal(await db.order.count({ where: { attemptId: attempts[4] } }), 0);
    const shipmentProviderId = await providerOrderId(attempts[4]);
    const shipmentCapture = orders.get(shipmentProviderId);
    assert.ok(shipmentCapture);
    shipmentCapture.purchase_units[0].payments = {
      captures: [{ id: `CAPTURE-${shipmentProviderId}`, status: "COMPLETED", amount: { currency_code: "USD", value: "21.99" } }],
    };
    const shipmentCallback = captureResource(shipmentProviderId);
    assert.deepEqual((await Promise.all([
      webhook("PAYMENT.CAPTURE.COMPLETED", shipmentCallback), webhook("PAYMENT.CAPTURE.COMPLETED", shipmentCallback),
    ])).map(response => response.status), [204, 204]);
    assert.equal(await db.order.count({ where: { attemptId: attempts[4] } }), 1);
    const shipment = await recoverPayPalCheckout(attempts[4], guestKey, "recover");
    assert.equal(shipment.kind, "placed");
    await advanceFulfillment(usPackerId, shipment.orderId, { next: "PACKING" });
    await advanceFulfillment(usPackerId, shipment.orderId, { next: "READY_TO_SHIP" });
    await advanceFulfillment(usPackerId, shipment.orderId, { next: "SHIPPED", carrier: "US test carrier", trackingReference: "TEST-US-001" });
    await advanceFulfillment(usPackerId, shipment.orderId, { next: "DELIVERED" });
    const delivered = await guestOrder(shipment.orderId, null, shopperId, "us");
    assert.equal(delivered?.fulfillmentStatus, "DELIVERED");
    assert.equal(delivered?.carrier, "US test carrier");
    assert.equal(delivered?.trackingReference, "TEST-US-001");
    assert.equal(delivered?.payment?.status, "PAID");
    await assert.rejects(refundPayPalOrder(staffId, shipment.orderId), /Only unshipped paid PayPal sandbox orders/);

    assert.equal((await recoverPayPalCheckout(attempts[5], guestKey, "recover")).kind, "abandoned");
    assert.equal((await createPayPalCheckout(input, attempts[5], quote.quote.quoteToken, guestKey)).kind, "conflict");
    assert.ok(provider.mock.callCount() > 0);
  } finally {
    const saved = await db.order.findMany({ where: { attemptId: { in: attempts } }, select: { id: true } });
    const orderIds = saved.map(({ id }) => id);
    await db.$transaction([
      db.auditEvent.deleteMany({ where: { target: { in: orderIds } } }),
      db.fulfillmentEvent.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.payment.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.order.deleteMany({ where: { id: { in: orderIds } } }),
      db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } }),
      db.user.deleteMany({ where: { id: { in: staffGrants.map(([id]) => id) } } }),
      db.shopper.deleteMany({ where: { id: { in: [shopperId, outsiderId] } } }),
      db.marketOffer.deleteMany({ where: { variantId } }),
      db.inventory.delete({ where: { variantId } }),
      db.variant.delete({ where: { id: variantId } }),
      db.product.delete({ where: { id: productId } }),
    ]);
  }
});
