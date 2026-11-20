import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { POST as paypalWebhook } from "../../src/app/api/checkout/paypal/webhook/route.ts";
import { POST as prepaidCallback } from "../../src/app/api/checkout/prepaid/callback/route.ts";
import { markets, type MarketId } from "../../src/config/markets.ts";
import type { Prisma } from "../../src/generated/prisma/client.ts";
import { requestDigest } from "../../src/lib/commerce/guest.ts";
import {
  cancelInventoryCommitment, dispatchInventoryAllocation, expireInventoryReservations, finalizeInventoryReservation,
  releaseInventoryReservation, reserveInventory, restockInventoryAllocation,
} from "../../src/lib/commerce/inventory-reservations.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { lockAttempt, recoverCheckout, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { dispatchOrderParcel, receiveRefusedOrderParcel, recordOrderParcelTracking } from "../../src/lib/commerce/order-parcels.ts";
import { reconcileExpiredPrepaid, recoverPrepaid, reviewPrepaid, startPrepaid } from "../../src/lib/commerce/prepaid-checkout.ts";
import { createPayPalCheckout, paypalQuote, recoverPayPalCheckout } from "../../src/lib/commerce/paypal-checkout.ts";
import { eligibleInventoryPools, initializeInventoryPool, recordStockMovement, saveWarehouseService } from "../../src/lib/commerce/physical-inventory.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { executeOrderCase, staffOrderCase } from "../../src/lib/marketplace/cases.ts";
import { advanceFulfillment, cancelOrder, collectCash, staffOrder } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());
const afterExpiry = (held: { expiresAt: Date }) => new Date(held.expiresAt.getTime() + 1);
type Reservation = Awaited<ReturnType<typeof reserveInventory>>;

async function fixture(t: TestContext, quantity: number) {
  const suffix = randomBytes(6).toString("hex");
  const productId = `fixture-reservation-${suffix}`;
  const variantId = `v-${productId}`;
  const locationId = `warehouse-${suffix}`;
  const restrictedLocationId = `bd-warehouse-${suffix}`;
  const method = `fixture-ground-${suffix}`;
  const deviceIds = [`phone-a-${suffix}`, `phone-b-${suffix}`];
  const owner = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" } });
  const actor = { kind: "staff", id: owner.userId } as const;
  const department = await db.department.findFirstOrThrow();
  const usPolicy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" } });
  const existingShop = await db.marketplaceShop.findUnique({ where: { id: storeShop.id } });
  const attemptIds: string[] = [];
  const keys = ["GRIIP_MARKETPLACE_PREVIEW", "GRIIP_MARKET_CONFIGURATION",
    "MARKETPLACE_SSLCOMMERZ_STORE_ID", "MARKETPLACE_SSLCOMMERZ_STORE_PASSWORD"] as const;
  const priorEnv = new Map(keys.map(key => [key, process.env[key]]));
  const destinations = {
    bd: { country: "BD", district: "dhaka", method: "standard", postalCode: null },
    us: { country: "US", district: "wa", method, postalCode: "98101" },
  };

  t.after(async () => {
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const attemptId = { in: attemptIds };
    const orders = await db.order.findMany({ where: { attemptId }, select: { id: true } });
    const orderId = { in: orders.map(order => order.id) };
    const cases = await db.orderCase.findMany({ where: { orderId }, select: { id: true } });
    await db.inventoryMovement.deleteMany({ where: { pool: { variantId } } });
    await db.inventoryAllocation.deleteMany({ where: { reservation: { attemptId } } });
    await db.inventoryReservation.deleteMany({ where: { attemptId } });
    await db.orderCase.deleteMany({ where: { orderId } });
    await db.orderParcel.deleteMany({ where: { orderId } });
    await db.fulfillmentEvent.deleteMany({ where: { orderId } });
    await db.payment.deleteMany({ where: { orderId } });
    await db.orderItem.deleteMany({ where: { orderId } });
    await db.order.deleteMany({ where: { attemptId } });
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
    await db.inventoryPool.deleteMany({ where: { variantId } });
    await db.marketOffer.deleteMany({ where: { variantId } });
    await db.marketOfferIdentity.deleteMany({ where: { variantId } });
    await db.variant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.deviceModel.deleteMany({ where: { id: { in: deviceIds } } });
    await db.dispatchLocationMarket.deleteMany({ where: { locationId: { in: [locationId, restrictedLocationId] } } });
    await db.dispatchLocation.deleteMany({ where: { id: { in: [locationId, restrictedLocationId] } } });
    await db.deliveryZone.deleteMany({ where: { marketId: "us", method } });
    await db.auditEvent.deleteMany({ where: { target: { in: [variantId, locationId, restrictedLocationId,
      ...orders.map(order => order.id), ...cases.map(row => row.id)] } } });
    if (!existingShop) await db.marketplaceShop.deleteMany({ where: { id: storeShop.id } });
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: usPolicy });
  });

  process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
  process.env.MARKETPLACE_SSLCOMMERZ_STORE_ID = "synthetic-reservation-test";
  process.env.MARKETPLACE_SSLCOMMERZ_STORE_PASSWORD = "synthetic-reservation-test";
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({
    us: {
      pricing: { priceList: "us-reservation-fixture", taxTreatment: "MERCHANDISE_RATE", rounding: "minor-half-up" },
      payments: [{ method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true }],
    },
  });
  await db.checkoutPolicy.update({ where: { marketId: "us" },
    data: { enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 0, taxLabel: "Fixture tax" } });
  await db.deliveryZone.create({ data: { marketId: "us", district: "wa", districtLabel: "Washington", method, label: "Fixture delivery", chargeMinor: 0 } });
  await db.marketplaceShop.upsert({ where: { id: storeShop.id }, update: {}, create: { ...storeShop, published: true, announcement: "", about: "" } });
  await db.deviceModel.createMany({ data: deviceIds.map((id, index) => ({
    id, brand: "Fixture", name: `Phone ${index + 1}`, lookupKey: id,
  })) });
  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: department.id, foundation: true, name: "Fixture universal stand",
    description: "One SKU compatible with two device models.", specifications: [], keywords: [], addedOn: new Date(), position: 0,
    publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId.toUpperCase(), options: {}, optionSignature: "[]", isDefault: true,
      label: "Standard", position: 0, compatibility: { createMany: { data: deviceIds.map(modelId => ({ modelId })) } },
    } },
  } });
  await db.dispatchLocation.createMany({ data: [
    { id: locationId, name: "Shared fixture dispatch", marketId: "bd" },
    { id: restrictedLocationId, name: "Bangladesh-only fixture dispatch", marketId: "bd" },
  ] });
  for (const [marketId, location] of [["bd", locationId], ["us", locationId], ["bd", restrictedLocationId]] as const) {
    const destination = destinations[marketId];
    await saveWarehouseService(actor, { locationId: location, marketId, active: true, priority: location === locationId ? 0 : 10,
      districts: [destination.district], methods: [destination.method] });
  }
  const pool = await initializeInventoryPool(actor, { variantId, locationId });
  const restrictedPool = await initializeInventoryPool(actor, { variantId, locationId: restrictedLocationId });
  await recordStockMovement(actor, { poolId: pool.id, kind: "RECEIPT", quantity, idempotencyKey: suffix,
    reason: "Synthetic stock receipt", reference: suffix });
  const bd = await saveConnectedOffer(actor, { variantId, marketId: "bd", sellerId: storeShop.id, expectedRevision: null,
    amountMinor: 110_000, publication: "ACTIVE", eligible: true });
  const us = await saveConnectedOffer(actor, { variantId, marketId: "us", sellerId: storeShop.id, expectedRevision: null,
    amountMinor: 1899, publication: "ACTIVE", eligible: true });
  const offers = { bd, us };

  async function attempt(marketId: MarketId, paymentMethod: "COD" | "SSLCOMMERZ" = "COD", requested = 1) {
    const attemptId = randomUUID();
    const guestKey = randomBytes(32).toString("hex");
    const checkoutHash = requestDigest(attemptId);
    const offer = offers[marketId];
    await db.checkoutAttempt.create({ data: { id: attemptId, marketId, paymentMethod, guestKey, requestHash: checkoutHash } });
    attemptIds.push(attemptId);
    const input = { attemptId, guestKey, checkoutHash, marketId, paymentMethod, destination: destinations[marketId],
      lines: [{ variantId, offerId: offer.id, revision: offer.revision, amountMinor: offer.amountMinor, quantity: requested }] };
    return {
      attemptId, input, proof: { kind: "cod", guestKey, checkoutHash }, guestProof: { kind: "guest", guestKey, checkoutHash },
      reserve: () => db.$transaction(tx => reserveInventory(tx, input)),
    };
  }
  async function balance() {
    const { onHand, reserved } = await db.inventoryPool.findUniqueOrThrow({ where: { id: pool.id } });
    return { onHand, reserved, available: onHand - reserved };
  }
  async function makeOrder(tx: Prisma.TransactionClient, reservation: Reservation, priceChange = 0) {
    const { attemptId, marketId, paymentMethod } = reservation;
    const currency = markets[marketId].currency;
    const count = reservation.allocations.reduce((sum, line) => sum + line.quantity, 0);
    const unitPriceMinor = offers[marketId].amountMinor + priceChange;
    const totalMinor = unitPriceMinor * count;
    return (await tx.order.create({
      data: {
        attemptId, marketId, currency, reference: `TEST-${attemptId}`, customerName: "Inventory test", phone: "01700000000",
        district: destinations[marketId].district, districtLabel: "Fixture district", locality: "Fixture locality",
        address: "Fixture delivery address", deliveryMethod: destinations[marketId].method, deliveryLabel: "Fixture delivery",
        taxLabel: "Test", subtotalMinor: totalMinor, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor,
        items: { create: {
          variantId, quantity: count, unitPriceMinor, unitDiscountMinor: 0, lineTotalMinor: totalMinor, currency,
          sku: variantId.toUpperCase(), productName: "Fixture universal stand", variantName: "Standard", offerIdSnapshot: offers[marketId].id,
        } },
        payment: { create: { method: paymentMethod, status: paymentMethod === "COD" ? "AWAITING_COLLECTION" : "PAID", amountMinor: totalMinor, currency } },
      }, select: { id: true },
    })).id;
  }
  function nativeBody(marketId: MarketId, paymentMethod: "COD" | "SSLCOMMERZ" = "COD") {
    const destination = destinations[marketId];
    return { marketId, paymentMethod, deliveryMethod: destination.method,
      items: [{ variantId, quantity: 1, offerId: offers[marketId].id, cartOfferId: offers.bd.id }],
      customer: {
        country: destination.country, district: destination.district, postalCode: destination.postalCode ?? undefined,
        locality: marketId === "bd" ? "Dhaka" : "Seattle", address: "100 Fixture Avenue",
        name: "Fixture buyer", email: "payment@example.invalid", phone: marketId === "bd" ? "01700000000" : "206-555-0123",
      },
    };
  }
  return { owner, variantId, productId, pool, restrictedPool, destinations, offers, attempt, balance, makeOrder,
    nativeBody, trackAttempt: (id: string) => attemptIds.push(id) };
}

test("actual COD checkout serializes both currencies against one pool and preserves the purchased offer", async t => {
  const fixtureRows = await fixture(t, 1);
  const { owner, offers, nativeBody, trackAttempt, variantId, productId, pool, balance } = fixtureRows;
  const shopper = await db.shopper.create({ data: { id: randomUUID(), email: `${productId}@example.invalid`, name: "Synthetic returning buyer" } });
  t.after(() => db.shopper.deleteMany({ where: { id: shopper.id } }));
  const reviews = await Promise.all((["bd", "us"] as const).map(async marketId => {
    const input = nativeBody(marketId);
    const guest = randomBytes(32).toString("hex");
    assert.equal((await reviewCheckout({ ...input, items: [{ ...input.items[0], offerId: randomUUID() }] }, marketId, guest)).kind, "unavailable");
    const review = await reviewCheckout(input, marketId, guest);
    assert.equal(review.kind, "review");
    trackAttempt(review.attemptId);
    assert.equal(review.quote.currency, markets[marketId].currency);
    assert.equal(review.quote.lines[0].offerIdSnapshot, offers[marketId].id);
    assert.equal(review.quote.lines[0].unitPriceMinor, offers[marketId].amountMinor);
    return { marketId, guest, review, submit: { ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken } };
  }));
  const results = await Promise.all(reviews.map(({ submit, marketId, guest }) => submitCheckout(submit, marketId, guest, shopper.id)));
  assert.equal(results.filter(result => result.kind === "placed").length, 1);
  const index = results.findIndex(result => result.kind === "placed");
  const result = results[index];
  assert.equal(result.kind, "placed");
  const { marketId, guest, review, submit } = reviews[index];
  assert.deepEqual(await submitCheckout(submit, marketId, guest, shopper.id), result);
  assert.deepEqual(await recoverCheckout(review.attemptId, guest, marketId), result);
  const order = await db.order.findUniqueOrThrow({ where: { id: result.orderId }, include: { items: true, payment: true, parcels: true } });
  assert.equal(order.payment?.status, "AWAITING_COLLECTION");
  assert.equal(order.parcels[0].locationId, pool.locationId);
  const commitment = await db.inventoryReservation.findUniqueOrThrow({ where: { orderId: order.id }, include: { allocations: true } });
  assert.equal(commitment.state, "COMMITTED");
  assert.equal(commitment.allocations[0].offerId, offers[marketId].id);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
  const before = order.items[0];
  await db.product.update({ where: { id: productId }, data: { name: "Renamed after checkout" } });
  await db.variant.update({ where: { id: variantId }, data: { label: "Edited label", isDefault: false, active: false, archivedAt: new Date() } });
  const after = await db.orderItem.findUniqueOrThrow({ where: { id: before.id } });
  assert.deepEqual(after, before);
  assert.equal(after.offerIdSnapshot, offers[marketId].id);
  assert.equal(after.cartOfferIdSnapshot, offers.bd.id);
  assert.equal(after.productIdSnapshot, productId);
  const parcel = order.parcels[0];
  const staff = await staffOrder(owner.userId, order.id);
  assert.equal(staff?.parcels[0].items[0].orderItem.sku, before.sku);
  assert.equal(staff?.parcels[0].items[0].orderItem.id, before.id);
  await advanceFulfillment(owner.userId, order.id, { next: "PACKING" });
  await advanceFulfillment(owner.userId, order.id, { next: "READY_TO_SHIP" });
  const handoff = () => dispatchOrderParcel(owner.userId, order.id, parcel.id, {
    carrier: "Synthetic dispatch", trackingReference: `track-${productId}`,
  });
  await Promise.all([handoff(), handoff()]);
  assert.deepEqual(await balance(), { onHand: 0, reserved: 0, available: 0 });
  assert.equal(await db.inventoryMovement.count({ where: { poolId: pool.id, kind: "DISPATCH" } }), 1);
  await recordOrderParcelTracking(owner.userId, order.id, parcel.id, { status: "DELIVERED", evidence: "isolated courier receipt" });
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId: order.id } })).status, "AWAITING_COLLECTION");
  await collectCash(owner.userId, order.id);
  const { id: caseId } = await executeOrderCase({ role: "shopper", id: shopper.id }, {
    action: "open", orderId: order.id, kind: "RETURN", note: "Return the inspected fixture line.",
    lines: [{ orderItemId: before.id, quantity: 1 }],
  });
  const actor = { role: "owner", id: owner.userId } as const;
  await executeOrderCase(actor, { action: "review", caseId, revision: 0, status: "IN_REVIEW", note: "Synthetic review" });
  await executeOrderCase(actor, { action: "review", caseId, revision: 1, status: "RETURN_APPROVED", note: "Synthetic approval" });
  await executeOrderCase(actor, { action: "receive", caseId, revision: 2, disposition: "RESTOCK", confirmed: true });
  await assert.rejects(executeOrderCase(actor, { action: "receive", caseId, revision: 2, disposition: "RESTOCK", confirmed: true }),
    /changed/);
  assert.equal((await staffOrderCase(owner.userId, caseId))?.returnLines[0].orderItem.sku, before.sku);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 0, available: 1 });
  assert.equal(await db.inventoryMovement.count({ where: { poolId: pool.id, kind: "RETURN" } }), 1);
});

test("native connected cancellation and refused parcel receipt restore the exact stock once", async t => {
  const { owner, nativeBody, trackAttempt, balance, pool } = await fixture(t, 1);
  const buyer = randomBytes(32).toString("hex");
  const body = nativeBody("bd");
  const place = async () => {
    const review = await reviewCheckout(body, "bd", buyer);
    assert.equal(review.kind, "review");
    trackAttempt(review.attemptId);
    const accepted = await submitCheckout({ ...body, attemptId: review.attemptId, reviewToken: review.quote.reviewToken }, "bd", buyer);
    assert.equal(accepted.kind, "placed");
    return accepted.orderId;
  };
  const cancelled = await place();
  await Promise.all([cancelOrder(owner.userId, cancelled), cancelOrder(owner.userId, cancelled)]);
  assert.equal((await db.inventoryReservation.findUniqueOrThrow({ where: { orderId: cancelled } })).state, "CANCELLED");
  assert.deepEqual(await balance(), { onHand: 1, reserved: 0, available: 1 });

  const orderId = await place();
  const parcel = await db.orderParcel.findFirstOrThrow({ where: { orderId } });
  await advanceFulfillment(owner.userId, orderId, { next: "PACKING" });
  await advanceFulfillment(owner.userId, orderId, { next: "READY_TO_SHIP" });
  await dispatchOrderParcel(owner.userId, orderId, parcel.id, { carrier: "Synthetic dispatch", trackingReference: "test-refusal" });
  await recordOrderParcelTracking(owner.userId, orderId, parcel.id, { status: "REFUSED", evidence: "Synthetic refusal" });
  const receive = () => receiveRefusedOrderParcel(owner.userId, orderId, parcel.id, { disposition: "RESTOCK", note: "Physically inspected fixture" });
  await Promise.all([receive(), receive()]);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId } })).status, "VOIDED");
  assert.deepEqual(await balance(), { onHand: 1, reserved: 0, available: 1 });
  assert.equal(await db.inventoryMovement.count({ where: { poolId: pool.id, kind: "RETURN" } }), 1);
});

function mockSslProvider(t: TestContext) {
  let state = "PENDING";
  let acceptedAmount = "0";
  t.mock.method(globalThis, "fetch", async (urlRaw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(urlRaw));
    assert.equal(url.origin, "https://sandbox.sslcommerz.com");
    if (init?.method === "POST") {
      assert.ok(init.body instanceof URLSearchParams);
      return Response.json({ status: "SUCCESS", GatewayPageURL: "https://sandbox.sslcommerz.com/synthetic-session" });
    }
    const providerId = url.searchParams.get("tran_id") ?? url.searchParams.get("val_id");
    const record = { status: state, tran_id: providerId, val_id: providerId, amount: acceptedAmount,
      currency: "BDT", currency_type: "BDT", risk_level: "0", bank_tran_id: `BANK-${providerId}` };
    return Response.json(url.pathname.endsWith("/validationserverAPI.php") ? record : { APIConnect: "DONE", element: [record] });
  });
  return (status: string, totalMinor: number) => {
    state = status;
    acceptedAmount = (totalMinor / 100).toFixed(2);
  };
}

function notifySsl(providerId: string) {
  return prepaidCallback(new Request("http://localhost/api/checkout/prepaid/callback?flow=notify", {
    method: "POST", body: new URLSearchParams({ tran_id: providerId, val_id: providerId, status: "VALIDATED" }),
  }));
}

test("verified SSLCOMMERZ payment reacquires an expired hold atomically and replays the accepted order", async t => {
  const { trackAttempt, nativeBody, balance, owner } = await fixture(t, 1);
  const guest = randomBytes(32).toString("hex");
  const body = nativeBody("bd", "SSLCOMMERZ");
  const review = await reviewPrepaid(body, guest, "bd");
  assert.equal(review.kind, "review");
  trackAttempt(review.attemptId);
  const providerStatus = mockSslProvider(t);
  const request = { ...body, attemptId: review.attemptId, reviewToken: review.quote.reviewToken };
  assert.equal((await startPrepaid(request, guest, false, undefined, "bd")).kind, "continue");
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
  assert.equal((await recoverPrepaid(review.attemptId, guest, false, "bd")).kind, "pending");
  const session = await db.prepaidCheckout.findUniqueOrThrow({ where: { attemptId: review.attemptId } });
  providerStatus("VALIDATED", 0);
  assert.equal((await notifySsl(session.providerId)).status, 200);
  assert.equal(await db.order.count({ where: { attemptId: review.attemptId } }), 0);
  await db.inventoryReservation.update({ where: { attemptId: review.attemptId }, data: { expiresAt: new Date(0) } });
  await db.prepaidCheckout.update({ where: { attemptId: review.attemptId }, data: { expiresAt: new Date(0) } });
  providerStatus("PENDING", 0);
  await reconcileExpiredPrepaid("bd");
  assert.deepEqual(await balance(), { onHand: 1, reserved: 0, available: 1 });
  providerStatus("VALIDATED", review.quote.totalMinor);
  const callbacks = await Promise.all([notifySsl(session.providerId), notifySsl(session.providerId)]);
  assert.deepEqual(callbacks.map(response => response.status), [200, 200]);
  const paid = await recoverPrepaid(review.attemptId, guest, false, "bd");
  assert.equal(paid.kind, "placed");
  const order = await db.order.findUniqueOrThrow({ where: { id: paid.orderId }, include: { payment: true, parcels: true } });
  assert.equal(order.payment?.status, "PAID");
  assert.equal(order.totalMinor, review.quote.totalMinor);
  assert.equal(order.parcels.length, 1);
  assert.equal(await db.order.count({ where: { attemptId: review.attemptId } }), 1);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
  await advanceFulfillment(owner.userId, order.id, { next: "PACKING" });
  const packing = await staffOrder(owner.userId, order.id);
  assert.equal(packing?.fulfillmentStatus, "PACKING");
  assert.equal(packing?.parcels[0].items[0].orderItem.sku, review.quote.lines[0].sku);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
});

test("late SSLCOMMERZ payment with unavailable stock records a verified exception and keeps the cart", async t => {
  const { trackAttempt, nativeBody, attempt, balance } = await fixture(t, 1);
  const guest = randomBytes(32).toString("hex");
  const body = nativeBody("bd", "SSLCOMMERZ");
  const review = await reviewPrepaid(body, guest, "bd");
  assert.equal(review.kind, "review");
  const { attemptId, quote } = review;
  trackAttempt(attemptId);
  const providerStatus = mockSslProvider(t);
  assert.equal((await startPrepaid({ ...body, attemptId, reviewToken: quote.reviewToken }, guest, false, undefined, "bd")).kind, "continue");
  await db.inventoryReservation.update({ where: { attemptId }, data: { expiresAt: new Date(0) } });
  await reconcileExpiredPrepaid("bd");
  const competing = await attempt("us");
  await competing.reserve();
  providerStatus("VALIDATED", quote.totalMinor);
  const before = await db.prepaidCheckout.findUniqueOrThrow({ where: { attemptId } });
  const callbacks = await Promise.all([notifySsl(before.providerId), notifySsl(before.providerId)]);
  assert.deepEqual(callbacks.map(response => response.status), [200, 200]);
  const exception = await db.inventoryReservation.findUniqueOrThrow({ where: { attemptId } });
  assert.equal(exception.state, "PAYMENT_EXCEPTION");
  assert.equal(exception.paymentReference, `BANK-${before.providerId}`);
  assert.equal(exception.paymentCurrency, "BDT");
  assert.equal(exception.paymentAmountMinor, quote.totalMinor);
  const session = await db.prepaidCheckout.findUniqueOrThrow({ where: { attemptId } });
  assert.equal(session.state, "CLOSED");
  assert.equal(session.quote, null);
  const recovery = await recoverPrepaid(attemptId, guest, false, "bd");
  assert.equal(recovery.kind, "pending");
  assert.match(recovery.message, /cart is saved.*refund needs reconciliation/i);
  assert.equal(await db.order.count({ where: { attemptId } }), 0);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
});

test("late PayPal capture with exhausted connected stock posts one durable refund and creates no order", async t => {
  const rows = await fixture(t, 1);
  const { trackAttempt, variantId, offers, owner, pool, destinations, attempt, balance } = rows;
  const overlay = JSON.parse(process.env.GRIIP_MARKET_CONFIGURATION ?? "{}");
  overlay.us.payments.push({ method: "PAYPAL", adapter: "paypal", evidence: "sandbox", enabled: true });
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify(overlay);
  const keys = ["MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR", "MARKETPLACE_PAYPAL_SANDBOX_CLIENT_ID",
    "MARKETPLACE_PAYPAL_SANDBOX_CLIENT_SECRET", "MARKETPLACE_PAYPAL_SANDBOX_WEBHOOK_ID"];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR = "599";
  process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_ID = "local-paypal-fixture";
  process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_SECRET = "local-paypal-fixture";
  process.env.MARKETPLACE_PAYPAL_SANDBOX_WEBHOOK_ID = "local-fixture-webhook";
  await saveWarehouseService({ kind: "staff", id: owner.userId }, { locationId: pool.locationId, marketId: "us", active: true,
    priority: 0, districts: [destinations.us.district], methods: [destinations.us.method, "sandbox-standard"] });
  const attemptId = randomUUID();
  trackAttempt(attemptId);
  const guest = randomBytes(32).toString("hex");
  const input = { items: [{ variantId, quantity: 1, offerId: offers.us.id, cartOfferId: offers.bd.id }], customer: {
    country: "US", name: "Sandbox buyer", addressLine1: "100 Test Street", city: "Seattle",
    state: "WA", postalCode: "98101", phone: "206-555-0123",
  } };
  const providerId = "CONNECTED-FIXTURE-ORDER";
  const captureId = "CONNECTED-FIXTURE-CAPTURE";
  let charges = 0;
  let refunds = 0;
  let refundStatus = "PENDING";
  let verifications = 0;
  const refundId = "CONNECTED-FIXTURE-REFUND";
  type MockOrder = { id: string; status: string; purchase_units: Record<string, unknown>[]; links: { href: string; rel: string }[] };
  let providerOrder: MockOrder | undefined;
  t.mock.method(globalThis, "fetch", async (request: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(request));
    assert.equal(url.origin, "https://api-m.sandbox.paypal.com");
    if (url.pathname === "/v1/oauth2/token") return Response.json({ access_token: "local-fixture-access", expires_in: 1000 });
    if (url.pathname === "/v1/notifications/verify-webhook-signature") {
      verifications++;
      const signature = JSON.parse(String(options?.body));
      assert.equal(signature.webhook_id, "local-fixture-webhook");
      return Response.json({ verification_status: signature.transmission_sig === "test-authentic" ? "SUCCESS" : "FAILURE" });
    }
    if (url.pathname === "/v2/checkout/orders" && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      providerOrder = { id: providerId, status: "APPROVED", purchase_units: body.purchase_units,
        links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${providerId}`, rel: "payer-action" }] };
      return Response.json(providerOrder);
    }
    assert.ok(providerOrder);
    const amount = { currency_code: "USD", value: "24.98" };
    if (url.pathname.endsWith("/capture")) {
      charges++;
      providerOrder.status = "COMPLETED";
      providerOrder.purchase_units[0].payments = { captures: [{ id: captureId, status: "COMPLETED", amount }] };
      throw new Error("Simulated lost capture response");
    }
    if (url.pathname.endsWith("/refund")) {
      refunds++;
      assert.ok(new Headers(options?.headers).has("PayPal-Request-Id"));
      return Response.json({ id: refundId, status: refundStatus, amount });
    }
    if (url.pathname === `/v2/payments/refunds/${refundId}`) return Response.json({ id: refundId, status: refundStatus, amount });
    assert.equal(url.pathname, `/v2/checkout/orders/${providerId}`);
    return Response.json(providerOrder);
  });
  const quote = await paypalQuote(input, guest, "us");
  assert.equal(quote.kind, "quoted");
  assert.equal(quote.quote.totalMinor, 2498);
  assert.equal((await createPayPalCheckout(input, attemptId, quote.quote.quoteToken, guest, undefined, "us")).kind, "approval_required");
  await assert.rejects(recoverPayPalCheckout(attemptId, guest, "capture", "us"), /Simulated lost capture/);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
  await db.inventoryReservation.update({ where: { attemptId }, data: { expiresAt: new Date(0) } });
  await expireInventoryReservations();
  assert.deepEqual(await balance(), { onHand: 1, reserved: 0, available: 1 });
  const competing = await attempt("bd");
  await competing.reserve();
  function webhook(event: object, signature?: string) {
    return paypalWebhook(new Request("http://localhost/api/checkout/paypal/webhook", {
      method: "POST", body: JSON.stringify(event), headers: { "content-type": "application/json", ...(signature && {
        "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api-m.sandbox.paypal.com/test-cert",
        "paypal-transmission-id": "local-fixture-transmission", "paypal-transmission-time": "2026-11-19T00:00:00Z",
        "paypal-transmission-sig": signature,
      }) },
    }));
  }
  const captured = { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { supplementary_data: { related_ids: { order_id: providerId } } } };
  assert.equal((await webhook(captured)).status, 403);
  assert.equal((await webhook(captured, "test-forged")).status, 403);
  assert.equal(verifications, 1);
  assert.equal(refunds, 0);
  assert.equal((await db.inventoryReservation.findUniqueOrThrow({ where: { attemptId } })).state, "EXPIRED");
  const notifications = await Promise.all([webhook(captured, "test-authentic"), webhook(captured, "test-authentic")]);
  assert.deepEqual(notifications.map(response => response.status), [204, 204]);
  assert.equal((await db.inventoryReservation.findUniqueOrThrow({ where: { attemptId } })).exceptionReason,
    "HOLD_CLOSED_BEFORE_VERIFIED_PAYMENT");
  refundStatus = "COMPLETED";
  const refunded = { event_type: "PAYMENT.REFUND.COMPLETED", resource: { id: refundId } };
  assert.equal((await webhook(refunded, "test-forged")).status, 403);
  const refundNotifications = await Promise.all([webhook(refunded, "test-authentic"), webhook(refunded, "test-authentic")]);
  assert.deepEqual(refundNotifications.map(response => response.status), [204, 204]);
  const exception = await db.inventoryReservation.findUniqueOrThrow({ where: { attemptId } });
  assert.equal(exception.state, "PAYMENT_EXCEPTION");
  assert.equal(exception.exceptionReason, "LATE_PAYMENT_REFUNDED");
  assert.equal(exception.paymentReference, captureId);
  assert.equal(exception.paymentAmountMinor, 2498);
  assert.equal(await db.order.count({ where: { attemptId } }), 0);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
  assert.deepEqual([charges, refunds], [1, 1]);
});

test("one shared last unit is reserved at most once across markets and replayed requests", async t => {
  const { variantId, pool, restrictedPool, destinations, attempt, balance } = await fixture(t, 1);
  for (const marketId of ["bd", "us"] as const) {
    const coverage = await eligibleInventoryPools(db, { variantId, ownerId: storeShop.id, marketId,
      paymentMethod: "COD", destination: destinations[marketId] });
    assert.equal(coverage.available, 1);
    assert.deepEqual(coverage.pools.map(row => row.id), marketId === "bd" ? [pool.id, restrictedPool.id] : [pool.id]);
  }
  assert.equal(await db.variantCompatibility.count({ where: { variantId } }), 2);
  assert.equal(await db.inventory.count({ where: { variantId } }), 0);
  const bd = await attempt("bd");
  const us = await attempt("us");
  const results = await Promise.allSettled([bd.reserve(), us.reserve()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected")?.reason.code, "out_of_stock");
  const winning = results[0].status === "fulfilled" ? bd : us;
  const [first, second] = await Promise.all([winning.reserve(), winning.reserve()]);
  assert.equal(first.id, second.id);
  assert.deepEqual(first.allocations.map(row => [row.currency, row.amountMinor, row.poolId]),
    [[markets[winning.input.marketId].currency, winning.input.lines[0].amountMinor, pool.id]]);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
  await assert.rejects(db.$transaction(tx => reserveInventory(tx, { ...winning.input,
    lines: [{ ...winning.input.lines[0], quantity: 2 }],
  })), /different checkout terms/);
  await assert.rejects(db.$transaction(tx => releaseInventoryReservation(tx, winning.attemptId,
    { ...winning.guestProof, guestKey: randomBytes(32).toString("hex") },
  )), /does not match/);
  for (let index = 0; index < 2; index++) {
    const released = await db.$transaction(tx => releaseInventoryReservation(tx, winning.attemptId, winning.guestProof));
    assert.equal(released.state, "RELEASED");
  }
  assert.deepEqual(await balance(), { onHand: 1, reserved: 0, available: 1 });
});

test("expiry releases only matching held inventory and undispatched cancellation releases a commitment once", async t => {
  const { owner, attempt, balance, makeOrder, variantId } = await fixture(t, 2);
  const held = await attempt("bd");
  const ordered = await attempt("bd");
  const hold = await held.reserve();
  await ordered.reserve();
  // A mismatched order and stock commitment roll back together.
  await assert.rejects(db.$transaction(tx => finalizeInventoryReservation(tx, ordered.attemptId, ordered.proof,
    (transaction, row) => makeOrder(transaction, row, 1),
  )), /reserved variants, prices and sellers/);
  assert.equal(await db.order.count({ where: { attemptId: ordered.attemptId } }), 0);
  const committed = await db.$transaction(tx => finalizeInventoryReservation(tx, ordered.attemptId, ordered.proof, makeOrder));
  assert.equal(committed.kind, "committed");
  await advanceFulfillment(owner.userId, committed.orderId, { next: "PACKING" });
  assert.deepEqual(await balance(), { onHand: 2, reserved: 2, available: 0 });
  assert.equal(await expireInventoryReservations(afterExpiry(hold), 20, ["irrelevant-variant"]), 0);
  assert.deepEqual(await balance(), { onHand: 2, reserved: 2, available: 0 });
  assert.equal(await expireInventoryReservations(afterExpiry(hold), 20, [variantId]), 1);
  assert.equal(await expireInventoryReservations(afterExpiry(hold), 20, [variantId]), 0);
  assert.deepEqual(await balance(), { onHand: 2, reserved: 1, available: 1 });
  assert.equal((await ordered.reserve()).state, "COMMITTED");
  await assert.rejects(db.$transaction(tx => cancelInventoryCommitment(tx, owner.userId, ordered.attemptId)), /approved.*cancellation/);
  await db.$transaction(async tx => {
    await lockAttempt(tx, ordered.attemptId);
    await tx.order.update({ where: { id: committed.orderId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    assert.equal((await cancelInventoryCommitment(tx, owner.userId, ordered.attemptId)).state, "CANCELLED");
  });
  assert.equal((await db.$transaction(tx => cancelInventoryCommitment(tx, owner.userId, ordered.attemptId))).state, "CANCELLED");
  assert.deepEqual(await balance(), { onHand: 2, reserved: 0, available: 2 });
});

test("late verified payment records one refund exception after stock has been allocated elsewhere", async t => {
  const { attempt, balance, offers } = await fixture(t, 1);
  const overdue = await attempt("bd", "SSLCOMMERZ");
  const hold = await overdue.reserve();
  await assert.rejects(db.$transaction(tx => releaseInventoryReservation(tx, overdue.attemptId, overdue.guestProof)), /provider closure/);
  assert.equal(await expireInventoryReservations(afterExpiry(hold)), 1);
  const next = await attempt("us");
  await next.reserve();
  const payment = { kind: "verified-payment", marketId: "bd", paymentMethod: "SSLCOMMERZ",
    reference: randomUUID(), currency: "BDT", amountMinor: offers.bd.amountMinor, recovery: overdue.input };
  const accept = () => db.$transaction(tx => finalizeInventoryReservation(tx, overdue.attemptId, payment,
    async () => assert.fail("A paid reservation with no stock must not place an order"), afterExpiry(hold),
  ));
  const events = await Promise.all([accept(), accept()]);
  assert.ok(events.every(event => event.kind === "refund_required"));
  assert.equal(events.filter(event => event.kind === "refund_required" && event.newlyRecorded).length, 1);
  const exception = await db.inventoryReservation.findUniqueOrThrow({ where: { attemptId: overdue.attemptId } });
  assert.deepEqual([exception.state, exception.paymentReference, exception.paymentAmountMinor, exception.paymentCurrency, exception.orderId],
    ["PAYMENT_EXCEPTION", payment.reference, payment.amountMinor, "BDT", null]);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 1, available: 0 });
  assert.equal(await db.order.count({ where: { attemptId: overdue.attemptId } }), 0);
  await assert.rejects(db.$transaction(tx => finalizeInventoryReservation(tx, overdue.attemptId,
    { ...payment, amountMinor: payment.amountMinor + 1 }, async () => assert.fail(),
  )), /different payment/);
});

test("late verified payment can reacquire the exact original fulfilment when it is still available", async t => {
  const { attempt, balance, offers, makeOrder } = await fixture(t, 2);
  const overdue = await attempt("bd", "SSLCOMMERZ");
  const held = await overdue.reserve();
  const now = afterExpiry(held);
  assert.equal(await expireInventoryReservations(now), 1);
  const payment = { kind: "verified-payment", marketId: "bd", paymentMethod: "SSLCOMMERZ",
    reference: randomUUID(), currency: "BDT", amountMinor: offers.bd.amountMinor, recovery: overdue.input };
  const accepted = await db.$transaction(tx => finalizeInventoryReservation(tx, overdue.attemptId, payment, makeOrder, now));
  assert.equal(accepted.kind, "committed");
  assert.deepEqual(await balance(), { onHand: 2, reserved: 1, available: 1 });
  assert.equal((await db.checkoutAttempt.findUniqueOrThrow({ where: { id: overdue.attemptId } })).abandonedAt, null);
  assert.equal(await db.order.count({ where: { attemptId: overdue.attemptId } }), 1);

  const ended = await attempt("bd", "SSLCOMMERZ");
  const another = await ended.reserve();
  assert.equal(await expireInventoryReservations(afterExpiry(another)), 1);
  const closed = await db.$transaction(tx => releaseInventoryReservation(tx, ended.attemptId, {
    kind: "provider-closed", marketId: "bd", paymentMethod: "SSLCOMMERZ",
  }));
  assert.equal(closed.state, "RELEASED");
  const contradictory = await db.$transaction(tx => finalizeInventoryReservation(tx, ended.attemptId,
    { ...payment, reference: randomUUID(), recovery: ended.input },
    async () => assert.fail("An explicit provider release cannot be reacquired"), afterExpiry(another),
  ));
  assert.equal(contradictory.kind, "refund_required");
  assert.deepEqual(await balance(), { onHand: 2, reserved: 1, available: 1 });
});

test("verified payment, dispatch and inspected restock post each physical movement once", async t => {
  const { owner, attempt, balance, offers, makeOrder, pool } = await fixture(t, 1);
  const paid = await attempt("bd", "SSLCOMMERZ");
  const held = await paid.reserve();
  const payment = { kind: "verified-payment", marketId: "bd", paymentMethod: "SSLCOMMERZ",
    reference: randomUUID(), currency: "BDT", amountMinor: offers.bd.amountMinor };
  const [first, replay] = await Promise.all([1, 2].map(() => db.$transaction(tx =>
    finalizeInventoryReservation(tx, paid.attemptId, payment, makeOrder))));
  assert.equal(first.kind, "committed");
  assert.deepEqual(first, replay);
  const allocationId = held.allocations[0].id;
  const input = { allocationId, eventId: "fixture-parcel-dispatched", reference: randomUUID(), quantity: 1 };
  await assert.rejects(db.$transaction(tx => dispatchInventoryAllocation(tx, randomUUID(), paid.attemptId, input)), /permission/i);
  const dispatches = await Promise.all([1, 2].map(() => db.$transaction(tx => dispatchInventoryAllocation(tx, owner.userId, paid.attemptId, input))));
  assert.equal(dispatches.filter(row => !row.replayed).length, 1);
  assert.deepEqual(await balance(), { onHand: 0, reserved: 0, available: 0 });
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: first.orderId } });
  const returned = await db.orderCase.create({ data: { orderId: first.orderId, kind: "RETURN", status: "RETURN_APPROVED",
    returnLines: { create: { orderItemId: item.id, quantity: 1 } },
  } });
  const receipt = { allocationId, caseId: returned.id, orderItemId: item.id, quantity: 1 };
  await assert.rejects(db.$transaction(tx => restockInventoryAllocation(tx, owner.userId, paid.attemptId, receipt)), /inspection approval/);
  await db.orderCase.update({ where: { id: returned.id }, data: { status: "RETURN_RECEIVED", returnReceivedAt: new Date(), returnDisposition: "RESTOCK" } });
  const returns = await Promise.all([1, 2].map(() => db.$transaction(tx => restockInventoryAllocation(tx, owner.userId, paid.attemptId, receipt))));
  assert.equal(returns.filter(row => !row.replayed).length, 1);
  assert.deepEqual(await balance(), { onHand: 1, reserved: 0, available: 1 });
  assert.deepEqual((await db.inventoryMovement.findMany({ where: { poolId: pool.id }, orderBy: { kind: "asc" } }))
    .map(row => [row.kind, row.quantity]), [["RECEIPT", 1], ["DISPATCH", -1], ["RETURN", 1]]);
});
