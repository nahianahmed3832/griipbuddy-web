import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { reviewCheckout, submitCheckout, recoverCheckout } from "../../src/lib/commerce/orders.ts";
import { dispatchOrderParcel, recordOrderParcelTracking } from "../../src/lib/commerce/order-parcels.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { commerceOutcomeSelect, projectCommerceOutcomes } from "../../src/lib/measurement/outcomes.ts";
import { cookieId, grantMeasurement, linkCheckoutAttempt, revokeMeasurement } from "../../src/lib/measurement/server.ts";
import { codReconciliationOrder, recordCodRemittance } from "../../src/lib/staff/cod-remittance.ts";
import { advanceFulfillment, collectCash } from "../../src/lib/staff/operations.ts";
import { executeOrderCase, staffOrderCase } from "../../src/lib/marketplace/cases.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("the same COD workflow uses an explicitly configured USD market with its own address, stock and collection", async () => {
  const env = process.env.GRIIP_MARKET_CONFIGURATION;
  const marketplace = process.env.GRIIP_MARKETPLACE_PREVIEW;
  const suffix = randomBytes(5).toString("hex");
  const productId = `fixture-market-${suffix}`;
  const variantId = `v-${productId}`;
  const locationId = `fixture-dispatch-${suffix}`;
  const method = `fixture-ground-${suffix}`;
  const couponCode = `FIXTURE-${suffix.toUpperCase()}`;
  const guest = randomBytes(32).toString("hex");
  const input: CheckoutDetails = {
    marketId: "us", paymentMethod: "COD", deliveryMethod: method, items: [{ variantId, quantity: 1 }],
    customer: {
      country: "US", district: "WA", locality: "Seattle", address: "100 Sample Avenue", postalCode: "98101",
      name: "Test Checkout", phone: "206-555-0123", email: "market-fixture@example.invalid",
    },
  };
  const policy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" } });
  const department = await db.department.findFirstOrThrow();
  const { userId: owner } = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const orderIds: string[] = [];
  const attemptIds: string[] = [];
  const caseIds: string[] = [];
  let consent: string | undefined;
  let shopperId: string | undefined;

  try {
    process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
    process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({});
    const unavailable = await reviewCheckout(input, "us", guest);
    assert.equal(unavailable.kind, "unavailable");
    process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({
      us: {
        revision: 2,
        pricing: { priceList: "us-fixture", taxTreatment: "MERCHANDISE_RATE", rounding: "minor-half-up" },
        payments: [{ method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true }],
      },
    });
    await db.checkoutPolicy.update({
      where: { marketId: "us" },
      data: { enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 625, taxLabel: "Fixture tax" },
    });
    await db.marketplaceCoupon.create({ data: { code: couponCode, marketId: "bd", kind: "FIXED", value: 100 } });
    const shopper = await db.shopper.create({ data: {
      id: randomUUID(), name: "Configured fixture shopper", email: `${suffix}@example.invalid`,
    } });
    shopperId = shopper.id;
    await db.deliveryZone.create({ data: {
      marketId: "us", district: "wa", districtLabel: "Washington", method, label: "Fixture ground parcel", chargeMinor: 599,
    } });
    await db.dispatchLocation.create({ data: { id: locationId, marketId: "us", name: "Fixture US dispatch" } });
    await db.product.create({ data: {
      id: productId, slug: productId, departmentId: department.id, name: "Shared architecture fixture",
      description: "Synthetic checkout fixture", keywords: [], specifications: {}, position: 9000, addedOn: new Date(), publication: "ACTIVE",
      variants: { create: { id: variantId, sku: variantId, label: "Fixture", position: 0, options: {},
        locationInventory: { create: { locationId, available: 1 } },
        offers: { create: [
          { marketId: "bd", currency: "BDT", amountMinor: 102_000 },
          { marketId: "us", currency: "USD", amountMinor: 1200 },
        ] },
      } },
    } });

    assert.equal((await reviewCheckout(input, "bd", guest)).kind, "invalid");
    assert.notEqual((await reviewCheckout({
      ...input, marketId: "bd", deliveryMethod: "standard",
      customer: { name: "Test Checkout", district: "dhaka", locality: "Dhaka", address: "100 Sample Avenue", phone: "01700000000" },
    }, "bd", guest)).kind, "review");
    assert.equal((await reviewCheckout({ ...input, customer: { ...input.customer, postalCode: "1200" } }, "us", guest)).kind, "invalid");
    assert.equal((await reviewCheckout({ ...input, couponCode }, "us", guest)).kind, "unavailable");

    consent = await grantMeasurement();
    const journeyId = cookieId(consent)!;
    const review = await reviewCheckout(input, "us", guest);
    assert.equal(review.kind, "review");
    attemptIds.push(review.attemptId);
    assert.deepEqual([review.quote.currency, review.quote.deliveryMinor, review.quote.taxMinor, review.quote.totalMinor], ["USD", 599, 75, 1874]);
    const session = randomUUID();
    await linkCheckoutAttempt(review.attemptId, guest, journeyId, "bd", randomUUID());
    assert.equal(await db.measurementAttempt.count({ where: { attemptId: review.attemptId } }), 0);
    await linkCheckoutAttempt(review.attemptId, guest, journeyId, "us", session);
    const accepted = await submitCheckout({ ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken }, "us", guest, shopperId);
    assert.equal(accepted.kind, "placed");
    orderIds.push(accepted.orderId);
    assert.equal((await recoverCheckout(review.attemptId, guest, "bd")).kind, "conflict");
    assert.deepEqual(await recoverCheckout(review.attemptId, guest, "us"), accepted);
    assert.equal((await db.locationInventory.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } })).available, 0);

    const order = await db.order.findUniqueOrThrow({ where: { id: accepted.orderId }, include: { parcels: true } });
    assert.equal(order.marketId, "us");
    assert.equal(order.currency, "USD");
    assert.equal(order.commerceEvidence, "fixture");
    assert.equal(order.measurementTest, true);
    assert.deepEqual(order.commercialSnapshot, {
      version: 1, marketId: "us", marketRevision: 2, countryCode: "US", currency: "USD",
      priceList: "us-fixture", rounding: "minor-half-up", taxTreatment: "MERCHANDISE_RATE",
      addressAdapter: "us-postal", paymentAdapter: "native-cod", paymentMethod: "COD",
      fulfillment: ["manual"], returns: ["manual"], evidence: "fixture",
      deliveryService: method, deliveryZone: "wa", deliveryRevision: 0, policyRevision: policy.revision, taxBasisPoints: 625,
    });
    const outcomes = async () => projectCommerceOutcomes(await db.order.findUniqueOrThrow({
      where: { id: order.id }, select: commerceOutcomeSelect,
    }), new Date());
    assert.deepEqual((await outcomes()).map(({ kind, marketId, evidence, sessionId }) => [kind, marketId, evidence, sessionId]), [
      ["ORDER_ACCEPTED", "us", "fixture", session],
    ]);
    await advanceFulfillment(owner, order.id, { next: "PACKING" });
    await advanceFulfillment(owner, order.id, { next: "READY_TO_SHIP" });
    const parcel = order.parcels[0];
    assert.equal(parcel.locationId, locationId);
    await dispatchOrderParcel(owner, order.id, parcel.id, { carrier: "Fixture carrier", trackingReference: `fixture-${suffix}` });
    await recordOrderParcelTracking(owner, order.id, parcel.id, { status: "DELIVERED", evidence: `delivery-${suffix}` });
    assert.deepEqual((await outcomes()).map(event => event.kind), ["ORDER_ACCEPTED", "ORDER_DELIVERED"]);
    await collectCash(owner, order.id);
    const remittance = { reference: `COD-${suffix}`, grossMinor: 1874, deductionsMinor: 99, netMinor: 1775 };
    assert.equal(await recordCodRemittance(owner, order.id, remittance), "MATCHED");
    assert.equal(await recordCodRemittance(owner, order.id, remittance), "MATCHED");
    assert.equal((await codReconciliationOrder(owner, order.id))?.currency, "USD");
    assert.deepEqual((await outcomes()).map(({ kind, amountMinor, currency }) => [kind, amountMinor, currency]), [
      ["ORDER_ACCEPTED", 1874, "USD"], ["ORDER_DELIVERED", null, "USD"],
      ["COD_COLLECTED", 1874, "USD"], ["COD_REMITTED", 1775, "USD"],
    ]);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const orderCase = await executeOrderCase({ role: "shopper", id: shopperId }, {
      action: "open", orderId: order.id, kind: "RETURN", note: "Isolated USD item return test",
      lines: [{ orderItemId: item.id, quantity: 1 }],
    });
    caseIds.push(orderCase.id);
    const ownerActor = { role: "owner", id: owner } as const;
    await executeOrderCase(ownerActor, { action: "review", caseId: orderCase.id, revision: 0, status: "IN_REVIEW", note: "Fixture review" });
    await executeOrderCase(ownerActor, { action: "review", caseId: orderCase.id, revision: 1, status: "RETURN_APPROVED", note: "Fixture approval" });
    await executeOrderCase(ownerActor, {
      action: "receive", caseId: orderCase.id, revision: 2, disposition: "RESTOCK", confirmed: true,
    });
    assert.equal((await db.locationInventory.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } })).available, 1);
    assert.equal((await staffOrderCase(owner, orderCase.id))?.refundLimitMinor, 1275);
    assert.deepEqual((await outcomes()).slice(-2).map(({ kind, marketId }) => [kind, marketId]), [
      ["RETURN_REQUESTED", "us"], ["RETURN_RECEIVED", "us"],
    ]);
  } finally {
    if (env === undefined) delete process.env.GRIIP_MARKET_CONFIGURATION;
    else process.env.GRIIP_MARKET_CONFIGURATION = env;
    if (marketplace === undefined) delete process.env.GRIIP_MARKETPLACE_PREVIEW;
    else process.env.GRIIP_MARKETPLACE_PREVIEW = marketplace;
    if (consent) await revokeMeasurement(consent);
    await db.$transaction([
      db.orderCaseReturnLine.deleteMany({ where: { caseId: { in: caseIds } } }),
      db.orderCaseEvent.deleteMany({ where: { caseId: { in: caseIds } } }),
      db.orderCase.deleteMany({ where: { id: { in: caseIds } } }),
      db.codRemittance.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.orderParcel.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.fulfillmentEvent.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.auditEvent.deleteMany({ where: { target: { in: [...orderIds, ...caseIds] } } }),
      db.payment.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
      db.order.deleteMany({ where: { id: { in: orderIds } } }),
      db.checkoutAttempt.deleteMany({ where: { id: { in: attemptIds } } }),
      db.shopper.deleteMany({ where: { id: shopperId ?? "" } }),
      db.marketplaceCoupon.deleteMany({ where: { code: couponCode } }),
      db.locationInventory.deleteMany({ where: { locationId } }),
      db.dispatchLocation.deleteMany({ where: { id: locationId } }),
      db.marketOffer.deleteMany({ where: { variantId } }),
      db.variant.deleteMany({ where: { id: variantId } }),
      db.product.deleteMany({ where: { id: productId } }),
      db.deliveryZone.deleteMany({ where: { marketId: "us", method } }),
      db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
        enabled: policy.enabled, codEnabled: policy.codEnabled, taxTreatment: policy.taxTreatment,
        taxBasisPoints: policy.taxBasisPoints, taxLabel: policy.taxLabel,
      } }),
    ]);
  }
});
