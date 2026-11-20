import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { acquisitionCampaign } from "../../src/lib/measurement/campaign.ts";
import {
  cookieId, grantMeasurement, linkAcceptedOrder, linkCheckoutAttempt, measurementInput, recordMeasurement, revokeMeasurement,
} from "../../src/lib/measurement/server.ts";
import { acquisitionReport } from "../../src/lib/measurement/report.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { cancelOrder } from "../../src/lib/staff/operations.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("versioned observations associate only authenticated sessions and withdrawal removes attempt linkage", async () => {
  const token = await grantMeasurement();
  const journeyId = cookieId(token)!;
  const sessionId = randomUUID();
  const attemptId = randomUUID();
  const guestKey = randomBytes(32).toString("hex");
  const shopperId = "authenticated-shopper-for-measurement-test";
  const context = { version: 1, at: new Date().toISOString(), sessionId, marketId: "bd" } as const;
  try {
    const search = measurementInput.parse({ ...context, action: "SEARCH", query: "customer@example.test", resultCount: 0, nonce: randomUUID() });
    assert.equal(search.action, "SEARCH");
    const association = measurementInput.parse({ ...context, action: "ACCOUNT_ASSOCIATED", nonce: randomUUID() });
    assert.equal(association.action, "ACCOUNT_ASSOCIATED");
    assert.ok(await recordMeasurement(journeyId, "bd", search));
    assert.ok(await recordMeasurement(journeyId, "bd", search));
    assert.equal(await recordMeasurement(journeyId, "bd", association), false);
    assert.ok(await recordMeasurement(journeyId, "bd", association, shopperId));
    const events = await db.measurementEvent.findMany({ where: { journeyId } });
    assert.equal(events.length, 2);
    const anonymous = events.find(event => event.kind === "SEARCH");
    const authenticated = events.find(event => event.kind === "ACCOUNT_ASSOCIATED");
    assert.deepEqual(anonymous?.details, { resultCount: 0 });
    assert.equal(anonymous?.accountKey, null);
    assert.equal(anonymous?.sessionId, authenticated?.sessionId);
    assert.match(authenticated?.accountKey ?? "", /^[a-f0-9]{64}$/);

    await db.checkoutAttempt.create({ data: {
      id: attemptId, guestKey, requestHash: "a".repeat(64), marketId: "bd", paymentMethod: "COD", commerceEvidence: "fixture",
    } });
    await linkCheckoutAttempt(attemptId, randomBytes(32).toString("hex"), journeyId, "bd", sessionId);
    assert.equal(await db.measurementAttempt.count({ where: { attemptId } }), 0);
    await linkCheckoutAttempt(attemptId, guestKey, journeyId, "bd", sessionId);
    await linkCheckoutAttempt(attemptId, guestKey, journeyId, "bd", randomUUID());
    assert.equal((await db.measurementAttempt.findUniqueOrThrow({ where: { attemptId } })).sessionId, sessionId);

    await revokeMeasurement(token);
    assert.equal(await db.measurementEvent.count({ where: { journeyId } }), 0);
    assert.equal(await db.measurementAttempt.count({ where: { attemptId } }), 0);
    assert.equal(await db.checkoutAttempt.count({ where: { id: attemptId } }), 1);
  } finally {
    await revokeMeasurement(token);
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
  }
});

test("known campaign survives checkout, test filters, cancellation and measurement withdrawal", async () => {
  const { productId, variantId, label, utm } = acquisitionCampaign;
  const guestKey = randomBytes(32).toString("hex");
  const otherGuest = randomBytes(32).toString("hex");
  const input: CheckoutDetails = {
    marketId: "bd", items: [{ variantId, quantity: 1 }], paymentMethod: "COD", deliveryMethod: "standard",
    customer: { name: "Fixture shopper", phone: "01700000000", district: "dhaka", locality: "Fixture",
      address: "Fixture address", email: "measurement-fixture@example.test" },
  };
  const baseline = await acquisitionReport({ marketId: "bd", test: true });
  assert.equal(baseline.kind, "report");
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const checkoutAttempts: string[] = [];
  let token: string | undefined;
  let orderId: string | undefined;
  await db.product.create({ data: {
    id: productId, slug: acquisitionCampaign.slug, departmentId: "d-electronics",
    name: "Local test copy of the acquisition SKU", description: "Test fixture only.",
    addedOn: new Date(), position: 99, specifications: [], keywords: [], demo: true, publication: "ACTIVE",
    variants: { create: { id: variantId, position: 0, sku: "TEST-ACQ-ONE", label: "Transparent", options: { Color: "Transparent" },
      offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 15000 } }, inventory: { create: { available: 3 } } } },
  } });
  try {
    token = await grantMeasurement();
    const journeyId = cookieId(token)!;
    assert.ok(journeyId);
    assert.equal(cookieId(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")), null);
    const observation = { action: "PRODUCT_VIEW" as const, variantId, nonce: randomUUID(), campaign: utm };
    assert.ok(await recordMeasurement(journeyId, "bd", observation));
    assert.ok(await recordMeasurement(journeyId, "bd", observation));
    assert.ok(await recordMeasurement(journeyId, "bd", { action: "CART_ADD", variantId, quantity: 1, nonce: randomUUID() }));
    assert.ok(await recordMeasurement(journeyId, "bd", { action: "CHECKOUT_START", nonce: randomUUID() }));
    assert.equal(await db.measurementEvent.count({ where: { journeyId } }), 3);

    const review = await reviewCheckout(input, "bd", guestKey);
    assert.equal(review.kind, "review");
    checkoutAttempts.push(review.attemptId);
    const placed = await submitCheckout({ ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken }, "bd", guestKey);
    assert.equal(placed.kind, "placed");
    orderId = placed.orderId;
    await linkAcceptedOrder(orderId, otherGuest, journeyId);
    assert.equal(await db.measurementOrder.count({ where: { orderId } }), 0);
    await linkAcceptedOrder(orderId, guestKey, journeyId);
    await linkAcceptedOrder(orderId, guestKey, journeyId);
    assert.equal(await db.measurementOrder.count({ where: { orderId } }), 1);

    const live = await acquisitionReport({ marketId: "bd", test: false });
    assert.equal(live.kind, "report");
    assert.equal(live.sources.get(label), undefined);
    const results = await acquisitionReport({ marketId: "bd", test: true });
    assert.equal(results.kind, "report");
    assert.deepEqual(results.sources.get(label), { product: 1, cart: 1, checkout: 1, accepted: 1, orders: 1, promotedOrders: 1 });
    assert.equal(results.matched, baseline.matched + 1);
    assert.equal(results.currencies.get("BDT")?.collected ?? 0n, baseline.currencies.get("BDT")?.collected ?? 0n);
    const accepted = results.debug.find(event => event.campaign === label && event.kind === "ORDER_ACCEPTED");
    assert.ok(accepted);

    await cancelOrder(owner.userId, orderId);
    await cancelOrder(owner.userId, orderId);
    const cancelled = await acquisitionReport({ marketId: "bd", test: true });
    assert.equal(cancelled.kind, "report");
    assert.equal(cancelled.cancelled, baseline.cancelled + 1);
    assert.equal(cancelled.debug.filter(row => row.campaign === label && row.kind === "ORDER_CANCELLED").length, 1);
    assert.equal(cancelled.debug.find(row => row.campaign === label && row.kind === "ORDER_ACCEPTED")?.id, accepted.id);

    await revokeMeasurement(token);
    assert.ok(await db.order.findUnique({ where: { id: orderId } }));
    assert.equal(await recordMeasurement(journeyId, "bd", observation), false);
    const withdrawn = await acquisitionReport({ marketId: "bd", test: true });
    assert.equal(withdrawn.kind, "report");
    assert.equal(withdrawn.sources.get(label), undefined);
    assert.equal(withdrawn.unmatched, baseline.unmatched + 1);
  } finally {
    if (token) await revokeMeasurement(token);
    await db.$transaction(async tx => {
      if (orderId) {
        await tx.auditEvent.deleteMany({ where: { target: orderId } });
        await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
        await tx.payment.deleteMany({ where: { orderId } });
        await tx.orderItem.deleteMany({ where: { orderId } });
        await tx.order.deleteMany({ where: { id: orderId } });
      }
      await tx.checkoutAttempt.deleteMany({ where: { id: { in: checkoutAttempts } } });
      await tx.inventory.deleteMany({ where: { variantId } });
      await tx.marketOffer.deleteMany({ where: { variantId } });
      await tx.variant.deleteMany({ where: { id: variantId } });
      await tx.product.deleteMany({ where: { id: productId } });
    });
  }
});
