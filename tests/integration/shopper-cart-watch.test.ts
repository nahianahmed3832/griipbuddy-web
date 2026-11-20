import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { checkoutCartMatches, syncShopperCart } from "../../src/lib/cart/shared-cart.ts";
import { cartSyncRequest, type CartChange } from "../../src/lib/cart/sync-contract.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { evaluateVariantWatches, updateVariantWatch } from "../../src/lib/marketplace/variant-watches.ts";
import { applyMarketplaceCommand } from "../../src/lib/marketplace/write.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.GRIIP_HYBRID_STOREFRONT = "1";
const db = getDb();
after(() => db.$disconnect());

async function shopperFixture(t: TestContext) {
  const suffix = randomUUID();
  const shoppers = [`cart-a-${suffix}`, `cart-b-${suffix}`];
  const [shopper, otherShopper] = shoppers;
  const productId = `qa-variant-${suffix}`;
  const variantId = `v-qa-exact-${suffix}`;
  const otherVariant = `v-qa-other-${suffix}`;
  const variants = [variantId, otherVariant];
  const bdLocation = `watch-bd-${suffix}`;
  const usLocation = `watch-us-${suffix}`;
  const locations = [bdLocation, usLocation];
  const attemptIds: string[] = [];
  const department = await db.department.findFirstOrThrow({ select: { id: true } });

  t.after(() => db.$transaction(async tx => {
    const orders = await tx.order.findMany({ where: { attemptId: { in: attemptIds } }, select: { id: true } });
    const ids = orders.map(order => order.id);
    const byOrder = { orderId: { in: ids } };
    await tx.fulfillmentEvent.deleteMany({ where: byOrder });
    await tx.payment.deleteMany({ where: byOrder });
    await tx.orderItem.deleteMany({ where: byOrder });
    await tx.order.deleteMany({ where: { id: { in: ids } } });
    await tx.checkoutAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await tx.shopper.deleteMany({ where: { id: { in: shoppers } } });
    await tx.locationInventory.deleteMany({ where: { locationId: { in: locations } } });
    await tx.dispatchLocation.deleteMany({ where: { id: { in: locations } } });
    await tx.marketOffer.deleteMany({ where: { variantId: { in: variants } } });
    await tx.inventory.deleteMany({ where: { variantId: { in: variants } } });
    await tx.variant.deleteMany({ where: { id: { in: variants } } });
    await tx.product.deleteMany({ where: { id: productId } });
  }));

  await db.shopper.createMany({ data: shoppers.map(id => ({ id, name: "Synthetic shopper", email: `${id}@example.invalid` })) });
  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: department.id, name: "Synthetic phone case", description: "Local QA fixture",
    keywords: [], specifications: [], position: 50, addedOn: new Date(), publication: "ACTIVE", personalizationPrompt: "Optional inscription",
    variants: { create: variants.map((id, index) => ({
      id, sku: id, label: index === 0 ? "Black" : "Clear", options: { color: index === 0 ? "Black" : "Clear" }, position: index,
      inventory: { create: { available: 10 } },
      offers: { create: [{ marketId: "bd", currency: "BDT", amountMinor: 10000 }, { marketId: "us", currency: "USD", amountMinor: 2500 }] },
    })) },
  } });
  return { shopper, otherShopper, variantId, otherVariant, bdLocation, usLocation, attemptIds };
}

test("shopper cart merges a guest cart once, serializes devices, and applies only authenticated purchases", async t => {
  const { shopper, otherShopper, variantId, otherVariant, attemptIds } = await shopperFixture(t);
  const item = { variantId, quantity: 1, personalization: "Alpha" };
  const separateLine = { ...item, personalization: "Beta" };
  const newLine = { ...item, personalization: "Gamma" };
  const savedLine = { variantId: otherVariant, quantity: 1 };
  await db.marketOffer.update({ where: { variantId_marketId: { variantId: otherVariant, marketId: "bd" } }, data: { eligible: false } });
  const base = { action: "cart-sync", shopperId: shopper, marketId: "bd" } as const;
  const merge = cartSyncRequest.parse({ ...base, mode: "merge", operationId: randomUUID(), items: [item, separateLine], saved: [savedLine] });
  assert.equal(merge.mode, "merge");
  const merges = await Promise.all([syncShopperCart(shopper, merge), syncShopperCart(shopper, merge)]);
  assert.deepEqual(merges[0], merges[1]);
  assert.equal(merges[0].status, 200);
  assert.deepEqual(merges[0].body.items, [item, separateLine]);
  assert.equal(merges[0].body.revision, 1);
  assert.deepEqual(merges[0].body.saved, [savedLine]);
  assert.equal((await syncShopperCart(otherShopper, merge)).status, 403);
  assert.equal((await syncShopperCart(shopper, { ...merge, items: [newLine] })).status, 409);
  const unrelated = await syncShopperCart(otherShopper, { ...base, mode: "read", shopperId: otherShopper });
  assert.equal(unrelated.status, 200);
  assert.deepEqual(unrelated.body.items, []);

  const change = (command: CartChange, actor = shopper, marketId: "bd" | "us" = "bd", revision?: number) =>
    syncShopperCart(actor, { ...base, mode: "change", marketId, shopperId: actor, operationId: randomUUID(), command, revision });
  const read = async () => {
    const result = await syncShopperCart(shopper, { ...base, mode: "read" });
    assert.equal(result.status, 200);
    return result.body;
  };
  const added = await Promise.all([change({ type: "add", ...item }), change({ type: "add", ...newLine })]);
  assert.ok(added.every(result => result.status === 200));
  const combined = await read();
  assert.equal(combined.revision, 3);
  assert.deepEqual(combined.items, [{ ...item, quantity: 2 }, separateLine, newLine]);
  const stale = await change({ type: "set", ...item, expectedQuantity: 1, quantity: 4 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.items, combined.items);
  assert.equal((await change({ type: "set", ...item, expectedQuantity: 2, quantity: 4 }, shopper, "bd", combined.revision - 1)).status, 409);
  const us = await change({ type: "add", ...item, quantity: 5 }, shopper, "us");
  assert.equal(us.status, 200);
  assert.deepEqual(us.body.items, [{ ...item, quantity: 5 }]);
  assert.deepEqual((await read()).items, combined.items);
  const saved = await change({ type: "move-to-saved", variantId, personalization: "Beta", expectedQuantity: 1 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.saved, [savedLine, separateLine]);

  const guest = randomBytes(32).toString("hex");
  const cart = { source: "cart" as const, revision: saved.body.revision };
  const checkout: CheckoutDetails = { marketId: "bd", deliveryMethod: "standard", paymentMethod: "COD",
    cart, items: [...saved.body.items], customer: {
    name: "Synthetic cart shopper", phone: "01700000000", district: "dhaka", locality: "Test locality", address: "Synthetic test address",
  } };
  assert.ok(await checkoutCartMatches(shopper, "bd", cart, checkout.items));
  assert.equal(await checkoutCartMatches(shopper, "us", cart, checkout.items), false);
  assert.equal(await checkoutCartMatches(shopper, "bd", cart, [item]), false);
  const quote = await reviewCheckout(checkout, "bd", guest, shopper);
  assert.equal(quote.kind, "review");
  attemptIds.push(quote.attemptId);
  assert.equal((await change({ type: "complete-purchase", orderId: quote.attemptId })).status, 404);
  assert.deepEqual(await read(), saved.body);
  const placed = await submitCheckout({ ...checkout, attemptId: quote.attemptId, reviewToken: quote.quote.reviewToken }, "bd", guest, shopper);
  assert.equal(placed.kind, "placed");
  assert.deepEqual((await read()).items, [{ ...item, quantity: 2 }, newLine]);
  assert.equal((await change({ type: "complete-purchase", orderId: placed.orderId }, otherShopper)).status, 404);
  assert.equal((await change({ type: "complete-purchase", orderId: placed.orderId }, shopper, "us")).status, 404);
  assert.equal((await change({ type: "add", ...item })).status, 200);
  assert.equal((await change({ type: "remove", variantId, personalization: newLine.personalization, expectedQuantity: 1 })).status, 200);
  assert.equal((await change({ type: "add", ...newLine })).status, 200);
  const completed = await Promise.all([change({ type: "complete-purchase", orderId: placed.orderId }), change({ type: "complete-purchase", orderId: placed.orderId })]);
  assert.deepEqual(completed[0], completed[1]);
  const final = await read();
  assert.deepEqual(final.items, [item, newLine]);
  assert.deepEqual(final.saved, [savedLine, separateLine]);
  const usAfter = await syncShopperCart(shopper, { ...base, marketId: "us", mode: "read" });
  assert.deepEqual(usAfter, us);
  assert.deepEqual(await syncShopperCart(shopper, merge), { status: 200, body: final });

  const direct: CheckoutDetails = { ...checkout, items: [item], cart: { source: "buy-now" } };
  const directQuote = await reviewCheckout(direct, "bd", guest, shopper);
  assert.equal(directQuote.kind, "review");
  attemptIds.push(directQuote.attemptId);
  const directPlaced = await submitCheckout({ ...direct, attemptId: directQuote.attemptId,
    reviewToken: directQuote.quote.reviewToken }, "bd", guest, shopper);
  assert.equal(directPlaced.kind, "placed");
  assert.equal((await change({ type: "complete-purchase", orderId: directPlaced.orderId })).status, 200);
  assert.deepEqual(await read(), final);
});

test("variant alerts detect each exact market independently, rearm, and avoid duplicates", async t => {
  const { shopper, otherShopper, variantId, otherVariant, bdLocation, usLocation } = await shopperFixture(t);
  await db.dispatchLocation.createMany({ data: [
    { id: bdLocation, name: "QA Dhaka", marketId: "bd" }, { id: usLocation, name: "QA US", marketId: "us" },
  ] });
  await db.locationInventory.createMany({ data: [
    { variantId, locationId: bdLocation, available: 0 }, { variantId, locationId: usLocation, available: 0 },
  ] });
  const bd = { variantId, marketId: "bd", backInStock: true, priceDrop: true } as const;
  const us = { ...bd, marketId: "us" } as const;
  const subscribe = { action: "variant-watch", shopperId: shopper, ...bd } as const;
  await assert.rejects(applyMarketplaceCommand(subscribe, { shopperId: otherShopper }), { status: 403 });
  await applyMarketplaceCommand(subscribe, { shopperId: shopper });
  await updateVariantWatch(otherShopper, us);
  const alerts = (shopperId: string) => db.shopperVariantWatchEvent.findMany({
    where: { watch: { shopperId } }, select: {
      kind: true, amountMinor: true, previousAmountMinor: true, watch: { select: { marketId: true, variantId: true } },
    }, orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
  });
  const setAvailable = (locationId: string, available: number) => db.locationInventory.update({
    where: { variantId_locationId: { variantId, locationId } }, data: { available },
  });
  const currentPrice = (marketId: "bd" | "us", amountMinor: number, id = variantId) => db.marketOffer.update({
    where: { variantId_marketId: { variantId: id, marketId } }, data: { amountMinor },
  });

  await currentPrice("bd", 8000, otherVariant);
  await setAvailable(usLocation, 2);
  await currentPrice("us", 2000);
  await Promise.all([evaluateVariantWatches(shopper), evaluateVariantWatches(otherShopper)]);
  assert.deepEqual(await alerts(shopper), []);
  const usAlerts = await alerts(otherShopper);
  assert.deepEqual(usAlerts.map(alert => [alert.kind, alert.watch.marketId, alert.watch.variantId]), [
    ["BACK_IN_STOCK", "us", variantId], ["PRICE_DROP", "us", variantId],
  ]);
  assert.deepEqual(usAlerts.filter(alert => alert.kind === "PRICE_DROP").map(alert => [alert.previousAmountMinor, alert.amountMinor]), [[2500, 2000]]);

  await setAvailable(bdLocation, 1);
  const now = Date.now();
  await db.marketOffer.update({
    where: { variantId_marketId: { variantId, marketId: "bd" } }, data: {
      discountMinor: 1000, discountStartsAt: new Date(now - 60_000), discountEndsAt: new Date(now + 600_000),
    },
  });
  await Promise.all([evaluateVariantWatches(shopper), evaluateVariantWatches(shopper), evaluateVariantWatches(shopper)]);
  const bdAlerts = await alerts(shopper);
  assert.deepEqual(bdAlerts.map(alert => [alert.kind, alert.watch.marketId, alert.watch.variantId]), [
    ["BACK_IN_STOCK", "bd", variantId], ["PRICE_DROP", "bd", variantId],
  ]);
  assert.deepEqual(bdAlerts.filter(alert => alert.kind === "PRICE_DROP").map(alert => [alert.previousAmountMinor, alert.amountMinor]), [[10000, 9000]]);
  await setAvailable(bdLocation, 0);
  await evaluateVariantWatches(shopper);
  await setAvailable(bdLocation, 1);
  await evaluateVariantWatches(shopper);
  assert.equal((await alerts(shopper)).filter(alert => alert.kind === "BACK_IN_STOCK").length, 2);

  await updateVariantWatch(shopper, { ...bd, backInStock: false });
  await setAvailable(bdLocation, 0);
  await evaluateVariantWatches(shopper);
  await setAvailable(bdLocation, 1);
  await currentPrice("bd", 9500);
  await evaluateVariantWatches(shopper);
  const finalAlerts = await alerts(shopper);
  assert.equal(finalAlerts.filter(alert => alert.kind === "BACK_IN_STOCK").length, 2);
  assert.deepEqual(finalAlerts.filter(alert => alert.kind === "PRICE_DROP").map(alert => [alert.previousAmountMinor, alert.amountMinor]), [[10000, 9000], [9000, 8500]]);
  await updateVariantWatch(shopper, { ...bd, backInStock: false, priceDrop: false });
  assert.deepEqual(await alerts(shopper), []);
  assert.deepEqual(await alerts(otherShopper), usAlerts);
});
