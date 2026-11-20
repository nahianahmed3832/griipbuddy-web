import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { guestOrder, recoverCheckout, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { initializeInventoryPool, recordStockMovement, saveWarehouseService } from "../../src/lib/commerce/physical-inventory.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { sellerOrderDetail } from "../../src/lib/marketplace/seller-orders.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

const bdCustomer = {
  name: "Synthetic checkout buyer", phone: "01700000000", district: "dhaka",
  locality: "Dhaka", address: "100 Fixture Avenue", email: "checkout-order@example.invalid",
};

test("native review binds shopper, market and cart revision, and exact retries preserve two sellers' allocated snapshots", async t => {
  const priorPreview = process.env.GRIIP_MARKETPLACE_PREVIEW;
  const priorMarket = process.env.GRIIP_MARKET_CONFIGURATION;
  process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
  t.after(() => {
    if (priorPreview === undefined) delete process.env.GRIIP_MARKETPLACE_PREVIEW;
    else process.env.GRIIP_MARKETPLACE_PREVIEW = priorPreview;
    if (priorMarket === undefined) delete process.env.GRIIP_MARKET_CONFIGURATION;
    else process.env.GRIIP_MARKET_CONFIGURATION = priorMarket;
  });

  const suffix = randomBytes(6).toString("hex");
  const buyerId = `quote-buyer-${suffix}`;
  const otherBuyerId = `quote-other-${suffix}`;
  const shopperIds = [buyerId, otherBuyerId];
  const guestKey = randomBytes(32).toString("hex");
  const shopIds = [randomUUID(), randomUUID()];
  const couponCode = `QUOTE${suffix.toUpperCase()}`;
  const productIds = [`quote-a-${suffix}`, `quote-b-${suffix}`];
  const variantIds = productIds.map(id => `v-${id}`);
  const locationIds = [`quote-loc-a-${suffix}`, `quote-loc-b-${suffix}`];
  const owner = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" } });
  const actor = { kind: "staff", id: owner.userId } as const;
  const department = await db.department.findFirstOrThrow();
  const knownAttempts: string[] = [];
  t.after(async () => {
    const attemptId = { in: knownAttempts };
    const orderId = { in: (await db.order.findMany({ where: { attemptId }, select: { id: true } })).map(order => order.id) };
    const variantId = { in: variantIds };
    await db.inventoryMovement.deleteMany({ where: { pool: { variantId } } });
    await db.inventoryAllocation.deleteMany({ where: { reservation: { attemptId } } });
    await db.inventoryReservation.deleteMany({ where: { attemptId } });
    await db.orderParcel.deleteMany({ where: { orderId } });
    await db.fulfillmentEvent.deleteMany({ where: { orderId } });
    await db.payment.deleteMany({ where: { orderId } });
    await db.orderItem.deleteMany({ where: { orderId } });
    await db.order.deleteMany({ where: { id: orderId } });
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
    await db.inventoryPool.deleteMany({ where: { variantId } });
    await db.marketOffer.deleteMany({ where: { variantId } });
    await db.marketOfferIdentity.deleteMany({ where: { variantId } });
    await db.variant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
    await db.dispatchLocationMarket.deleteMany({ where: { locationId: { in: locationIds } } });
    await db.dispatchLocation.deleteMany({ where: { id: { in: locationIds } } });
    await db.marketplaceCoupon.deleteMany({ where: { code: couponCode } });
    await db.marketplaceShop.deleteMany({ where: { id: { in: shopIds } } });
    await db.shopper.deleteMany({ where: { id: { in: shopperIds } } });
    await db.auditEvent.deleteMany({ where: { target: { in: [...locationIds, ...variantIds] } } });
  });

  await db.shopper.createMany({ data: shopperIds.map(id => ({ id, email: `${id}@example.invalid`, name: "Order fixture" })) });
  const offers = [];
  for (const [index, shopId] of shopIds.entries()) {
    const productId = productIds[index];
    const variantId = variantIds[index];
    const locationId = locationIds[index];
    await db.marketplaceShop.create({ data: {
      id: shopId, slug: productId, name: `Order-time seller ${index}`, published: true, announcement: "", about: "",
      marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
    } });
    await db.product.create({ data: {
      id: productId, slug: productId, departmentId: department.id, foundation: true, name: `Purchased product ${index}`,
      description: "Synthetic checkout allocation fixture", specifications: [], keywords: [], addedOn: new Date(), position: 0,
      marketplaceShopId: shopId, publication: "ACTIVE",
      variants: { create: { id: variantId, sku: variantId.toUpperCase(), options: {}, optionSignature: "[]", isDefault: true,
        label: "Standard", position: 0 } },
    } });
    await db.dispatchLocation.create({ data: { id: locationId, name: `Fixture dispatch ${index}`, marketId: "bd", shopId } });
    await saveWarehouseService(actor, { locationId, marketId: "bd", active: true, priority: 100,
      districts: ["dhaka"], methods: ["standard"] });
    const pool = await initializeInventoryPool(actor, { variantId, locationId });
    await recordStockMovement(actor, { poolId: pool.id, kind: "RECEIPT", quantity: 2, idempotencyKey: suffix,
      reason: "Order fixture opening stock", reference: suffix });
    offers.push(await saveConnectedOffer(actor, { variantId, marketId: "bd", sellerId: shopId,
      expectedRevision: null, amountMinor: index === 0 ? 101 : 181, publication: "ACTIVE", eligible: true }));
  }
  await db.marketplaceCoupon.create({ data: { code: couponCode, shopId: shopIds[0], kind: "FIXED", value: 1, minimumMinor: 0 } });
  await db.shopperMarketCart.create({ data: {
    marketId: "bd", shopperId: buyerId, revision: 6,
    items: offers.map(offer => ({ variantId: offer.variantId, offerId: offer.id, quantity: 1 })),
  } });
  const input: CheckoutDetails = {
    marketId: "bd", paymentMethod: "COD", deliveryMethod: "standard", customer: bdCustomer, couponCode,
    cart: { source: "cart", revision: 6 },
    items: offers.map(offer => ({ variantId: offer.variantId, offerId: offer.id, cartOfferId: offer.id, quantity: 1 })),
  };
  assert.equal((await reviewCheckout(input, "bd", guestKey, otherBuyerId)).kind, "conflict");
  assert.equal((await reviewCheckout({ ...input, deliveryMethod: "pickup" }, "bd", guestKey, buyerId)).kind, "unavailable");
  const review = await reviewCheckout(input, "bd", guestKey, buyerId);
  assert.equal(review.kind, "review");
  knownAttempts.push(review.attemptId);
  assert.equal(review.quote.currency, "BDT");
  assert.equal(review.quote.totalMinor, 8295);
  const savedReview = await db.checkoutAttempt.findUniqueOrThrow({ where: { id: review.attemptId } });
  assert.equal(savedReview.quoteExpiresAt?.toISOString(), review.quote.expiresAt);
  assert.equal(savedReview.reviewActor, `shopper:${buyerId}`);
  assert.equal(savedReview.cartSource, "cart");
  assert.equal(savedReview.cartRevision, 6);

  const payload = { ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken };
  assert.equal((await submitCheckout(payload, "bd", guestKey, otherBuyerId)).kind, "conflict");
  assert.equal((await recoverCheckout(review.attemptId, guestKey, "bd", null)).kind, "conflict");
  assert.equal((await submitCheckout({ ...payload, cart: { source: "cart", revision: 7 } }, "bd", guestKey, buyerId)).kind, "conflict");
  const cartKey = { shopperId_marketId: { shopperId: buyerId, marketId: "bd" } } as const;
  await db.shopperMarketCart.update({ where: cartKey, data: { revision: 7 } });
  assert.equal((await submitCheckout(payload, "bd", guestKey, buyerId)).kind, "conflict");
  assert.equal(await db.inventoryReservation.count({ where: { attemptId: review.attemptId } }), 0);

  const currentInput = { ...input, cart: { source: "cart", revision: 7 } } as const;
  const currentReview = await reviewCheckout(currentInput, "bd", guestKey, buyerId);
  assert.equal(currentReview.kind, "review");
  knownAttempts.push(currentReview.attemptId);
  const currentPayload = { ...currentInput, attemptId: currentReview.attemptId, reviewToken: currentReview.quote.reviewToken };
  await db.checkoutAttempt.update({ where: { id: currentReview.attemptId }, data: { quoteExpiresAt: new Date(Date.now() - 1) } });
  const renewed = await submitCheckout(currentPayload, "bd", guestKey, buyerId);
  assert.equal(renewed.kind, "changed");
  assert.match(renewed.message ?? "", /expired/);
  assert.notEqual(renewed.quote.reviewToken, currentPayload.reviewToken);
  assert.equal(await db.order.count({ where: { attemptId: currentReview.attemptId } }), 0);
  const retried = { ...currentPayload, reviewToken: renewed.quote.reviewToken };
  const [placed, repeated] = await Promise.all([submitCheckout(retried, "bd", guestKey, buyerId), submitCheckout(retried, "bd", guestKey, buyerId)]);
  assert.equal(placed.kind, "placed");
  assert.deepEqual(repeated, placed);
  assert.deepEqual(await recoverCheckout(currentReview.attemptId, guestKey, "bd", buyerId), placed);
  assert.equal(await guestOrder(placed.orderId, guestKey, otherBuyerId), null);
  assert.equal(await guestOrder(placed.orderId, guestKey), null);
  const order = await guestOrder(placed.orderId, null, buyerId);
  assert.ok(order);
  assert.equal(order.shopperId, buyerId);
  assert.deepEqual([order.marketId, order.currency, order.taxMinor, order.deliveryMinor, order.totalMinor], ["bd", "BDT", 14, 8000, 8295]);
  assert.equal(order.payment?.status, "AWAITING_COLLECTION");
  assert.equal(order.parcels.length, 2);
  assert.deepEqual(order.items.map(line => [line.marketplaceShopId, line.marketplaceShopNameSnapshot, line.productIdSnapshot,
    line.offerIdSnapshot, line.pricedOfferRevision, line.couponDiscountMinor, line.lineTotalMinor,
    line.deliveryAllocatedMinor, line.taxAllocatedMinor]), [
    [shopIds[0], "Order-time seller 0", productIds[0], offers[0].id, offers[0].revision, 1, 100, 2847, 5],
    [shopIds[1], "Order-time seller 1", productIds[1], offers[1].id, offers[1].revision, 0, 181, 5153, 9],
  ]);
  assert.equal(order.items.reduce((sum, line) => sum + line.lineTotalMinor + line.deliveryAllocatedMinor! + line.taxAllocatedMinor!, 0), order.totalMinor);
  assert.deepEqual((await db.inventoryPool.findMany({ where: { variantId: { in: variantIds } }, select: { onHand: true, reserved: true } }))
    .map(({ onHand, reserved }) => [onHand, reserved]), [[2, 1], [2, 1]]);

  await db.marketplaceShop.update({ where: { id: shopIds[0] }, data: { name: "Renamed fixture seller" } });
  await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: shopIds[0], marketId: "bd" } }, data: { status: "DENIED" } });
  await db.product.update({ where: { id: productIds[0] }, data: { name: "Renamed fixture product" } });
  const sellerOrder = await sellerOrderDetail(shopIds[0], placed.orderId, "bd");
  assert.equal(sellerOrder?.items.length, 1);
  assert.deepEqual(sellerOrder.items.map(line => [line.productName, line.deliveryAllocatedMinor, line.taxAllocatedMinor]), [["Purchased product 0", 2847, 5]]);
  assert.equal(await sellerOrderDetail(shopIds[0], placed.orderId, "us"), null);
  assert.equal(await sellerOrderDetail(randomUUID(), placed.orderId, "bd"), null);
  assert.equal((await guestOrder(placed.orderId, null, buyerId))?.items[0].marketplaceShopNameSnapshot, "Order-time seller 0");
  assert.equal((await reviewCheckout({ ...currentInput, cart: undefined }, "bd", guestKey, buyerId)).kind, "unavailable");

  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ bd: { status: "paused" } });
  assert.equal((await reviewCheckout(input, "bd", guestKey, buyerId)).kind, "unavailable");
  assert.deepEqual(await submitCheckout(retried, "bd", guestKey, buyerId), placed);
});
