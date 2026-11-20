import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { dispatchOrderParcel, receiveRefusedOrderParcel, recordOrderParcelTracking } from "../../src/lib/commerce/order-parcels.ts";
import { guestOrder, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { executeOrderCase } from "../../src/lib/marketplace/cases.ts";
import { sellerOrderRange } from "../../src/lib/marketplace/seller-order-range.ts";
import { sellerOrderPage } from "../../src/lib/marketplace/seller-orders.ts";
import { applyMarketplaceCommand } from "../../src/lib/marketplace/write.ts";
import { codReconciliationOrder, listCodReconciliation } from "../../src/lib/staff/cod-remittance.ts";
import { advanceFulfillment, cancelOrder, collectCash } from "../../src/lib/staff/operations.ts";
import { prepareOrderParcels } from "./fixtures/prepare-parcels.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.GRIIP_HYBRID_STOREFRONT = "1";
const db = getDb();
after(() => db.$disconnect());

const storeVariant = "v-tee-sage-s";
const sellerVariant = "v-tote-oat";

async function locationFixture(t: TestContext) {
  const shopId = randomUUID();
  const sellerId = `location-seller-${shopId}`;
  const bdStore = `fixture-bd-${shopId}`;
  const usStore = `fixture-us-${shopId}`;
  const bdSeller = `fixture-seller-${shopId}`;
  const backupBd = `fixture-backup-${shopId}`;
  const disabled = `fixture-inactive-${shopId}`;
  const locationIds = [bdStore, usStore, bdSeller, backupBd, disabled];
  const variants = await db.variant.findMany({
    where: { id: { in: [storeVariant, sellerVariant] } },
    select: { id: true, inventory: { select: { available: true } }, product: { select: { id: true, marketplaceShopId: true } } },
  });
  const storedVariant = variants.find(variant => variant.id === storeVariant);
  const merchantVariant = variants.find(variant => variant.id === sellerVariant);
  assert.ok(storedVariant?.inventory && merchantVariant?.inventory);
  const actors = await db.staffAccess.findMany({ where: { active: true }, select: { userId: true, role: true } });
  const owner = actors.find(actor => actor.role === "OWNER")?.userId;
  const packer = actors.find(actor => actor.role === "PACKER")?.userId;
  assert.ok(owner && packer);
  const attemptIds: string[] = [];

  t.after(() => db.$transaction(async tx => {
    const orders = await tx.order.findMany({ where: { attemptId: { in: attemptIds } }, select: { id: true } });
    const ids = orders.map(order => order.id);
    const byOrder = { orderId: { in: ids } };
    const cases = await tx.orderCase.findMany({ where: byOrder, select: { id: true } });
    await tx.orderCase.deleteMany({ where: byOrder });
    await tx.orderParcel.deleteMany({ where: byOrder });
    await tx.bangladeshShipmentEvent.deleteMany({ where: byOrder });
    await tx.bangladeshShipment.deleteMany({ where: byOrder });
    await tx.fulfillmentEvent.deleteMany({ where: byOrder });
    await tx.auditEvent.deleteMany({ where: { target: { in: [...ids, ...cases.map(row => row.id)] } } });
    await tx.auditEvent.deleteMany({ where: { action: "STOCK_CHANGED", changes: { path: ["locationId"], equals: bdSeller } } });
    await tx.payment.deleteMany({ where: byOrder });
    await tx.orderItem.deleteMany({ where: byOrder });
    await tx.order.deleteMany({ where: { id: { in: ids } } });
    await tx.checkoutAttempt.deleteMany({ where: { id: { in: attemptIds } } });
    await tx.locationInventory.deleteMany({ where: { locationId: { in: locationIds } } });
    await tx.dispatchLocation.deleteMany({ where: { id: { in: locationIds } } });
    for (const variant of variants) {
      await tx.product.update({ where: { id: variant.product.id }, data: { marketplaceShopId: variant.product.marketplaceShopId } });
      if (variant.inventory) await tx.inventory.update({ where: { variantId: variant.id }, data: { available: variant.inventory.available } });
    }
    await tx.marketplaceShop.deleteMany({ where: { id: shopId } });
    await tx.shopper.deleteMany({ where: { id: sellerId } });
  }));

  await db.$transaction(async tx => {
    await tx.shopper.create({ data: { id: sellerId, email: `${sellerId}@example.invalid`, name: "Dispatch test seller" } });
    await tx.marketplaceShop.create({ data: {
      id: shopId, ownerId: sellerId, published: true, slug: `location-${shopId}`, name: "Dispatch test shop", announcement: "", about: "",
      marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
    } });
    await tx.product.update({ where: { id: storedVariant.product.id }, data: { marketplaceShopId: null } });
    await tx.product.update({ where: { id: merchantVariant.product.id }, data: { marketplaceShopId: shopId } });
    await tx.inventory.updateMany({ where: { variantId: { in: [storeVariant, sellerVariant] } }, data: { available: 0 } });
    await tx.dispatchLocation.createMany({ data: [
      { id: bdStore, name: "Dhaka warehouse", marketId: "bd" },
      { id: usStore, name: "US warehouse", marketId: "us" },
      { id: bdSeller, name: "Seller dispatch", marketId: "bd", shopId },
      { id: backupBd, name: "Backup warehouse", marketId: "bd", priority: 200 },
      { id: disabled, name: "Offline stock", marketId: "bd", active: false },
    ] });
    await tx.locationInventory.createMany({ data: [
      { variantId: storeVariant, locationId: bdStore, available: 2 },
      { variantId: storeVariant, locationId: usStore, available: 5 },
      { variantId: sellerVariant, locationId: bdSeller, available: 3 },
      { variantId: storeVariant, locationId: disabled, available: 9 },
    ] });
  });

  async function preparedCheckout(items: CheckoutDetails["items"]) {
    const key = randomBytes(32).toString("hex");
    const checkout: CheckoutDetails = {
      marketId: "bd", items, paymentMethod: "COD", deliveryMethod: "standard",
      customer: { name: "Synthetic parcel shopper", phone: "01700000000", district: "dhaka", locality: "Test locality", address: "Synthetic test address only" },
    };
    const quoted = await reviewCheckout(checkout, "bd", key);
    assert.equal(quoted.kind, "review");
    attemptIds.push(quoted.attemptId);
    return { key, submit: (shopperId?: string) => submitCheckout({ ...checkout, attemptId: quoted.attemptId, reviewToken: quoted.quote.reviewToken }, "bd", key, shopperId) };
  }

  return { owner, packer, sellerId, shopId, bdStore, usStore, bdSeller, backupBd, preparedCheckout };
}

async function stock(variantId: string, locationId: string) {
  return (await db.locationInventory.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } })).available;
}

test("a mixed order has independently tracked warehouse and seller parcels with exact refused stock restoration", async t => {
  const { owner, packer, shopId, sellerId, bdStore, usStore, bdSeller, preparedCheckout } = await locationFixture(t);
  const [bdOffer] = await catalog.resolveVariants([storeVariant], "bd");
  const [usOffer] = await catalog.resolveVariants([storeVariant], "us");
  assert.equal(bdOffer.offer?.stock, 2);
  assert.equal(usOffer.offer?.stock, 5);
  assert.deepEqual(await catalog.resolveVariants([sellerVariant], "us"), []);
  const adjustment = { action: "seller-location-stock", variantId: sellerVariant, locationId: bdSeller, expectedAvailable: 3, available: 4 } as const;
  await assert.rejects(applyMarketplaceCommand(adjustment, { shopperId: "different-shopper" }), /unavailable/i);
  await assert.rejects(applyMarketplaceCommand({ ...adjustment, marketId: "us" },
    { shopperId: sellerId, marketId: "us" }), { status: 404 });
  await assert.rejects(applyMarketplaceCommand({ ...adjustment, variantId: storeVariant, locationId: bdStore }, { shopperId: sellerId }), /unavailable/i);
  await applyMarketplaceCommand(adjustment, { shopperId: sellerId });
  await assert.rejects(applyMarketplaceCommand({ ...adjustment, available: 9 }, { shopperId: sellerId }), /stock count changed/i);
  await applyMarketplaceCommand({ ...adjustment, expectedAvailable: 4, available: 3 }, { shopperId: sellerId });
  const attempt = await preparedCheckout([{ variantId: storeVariant, quantity: 1 }, { variantId: sellerVariant, quantity: 1 }]);
  const placed = await attempt.submit();
  assert.equal(placed.kind, "placed");
  const { orderId } = placed;
  const parcels = await db.orderParcel.findMany({ where: { orderId }, include: { items: { include: { orderItem: true } } } });
  assert.equal(parcels.length, 2);
  const storeParcel = parcels.find(parcel => parcel.locationId === bdStore);
  const sellerParcel = parcels.find(parcel => parcel.locationId === bdSeller);
  assert.ok(storeParcel && sellerParcel);
  assert.deepEqual(storeParcel.items.map(item => [item.orderItem.variantId, item.quantity]), [[storeVariant, 1]]);
  assert.deepEqual(sellerParcel.items.map(item => [item.orderItem.variantId, item.quantity]), [[sellerVariant, 1]]);
  assert.equal(await stock(storeVariant, bdStore), 1);
  assert.equal(await stock(storeVariant, usStore), 5);
  assert.equal(await stock(sellerVariant, bdSeller), 2);

  await prepareOrderParcels(packer, orderId);
  await assert.rejects(advanceFulfillment(owner, orderId, { next: "SHIPPED", carrier: "Fixture courier", trackingReference: "WHOLE-ORDER" }), /parcel/i);
  await dispatchOrderParcel(packer, orderId, storeParcel.id, { carrier: "Fixture courier", trackingReference: "DH-PARCEL" });
  await assert.rejects(dispatchOrderParcel(packer, orderId, sellerParcel.id, { carrier: "Fixture courier", trackingReference: "dh-parcel" }), /tracking/i);
  await dispatchOrderParcel(packer, orderId, sellerParcel.id, { carrier: "Fixture courier", trackingReference: "SELLER-PARCEL" });
  await recordOrderParcelTracking(packer, orderId, storeParcel.id, { status: "DELIVERED", evidence: "Synthetic delivery evidence" });
  await assert.rejects(collectCash(owner, orderId), /delivered/i);
  await recordOrderParcelTracking(owner, orderId, sellerParcel.id, { status: "REFUSED", evidence: "Synthetic refusal evidence" });
  const receipt = { disposition: "RESTOCK", note: "Synthetic parcel physically returned and inspected." };
  await receiveRefusedOrderParcel(packer, orderId, sellerParcel.id, receipt);
  await Promise.allSettled([receiveRefusedOrderParcel(packer, orderId, sellerParcel.id, receipt), receiveRefusedOrderParcel(owner, orderId, sellerParcel.id, receipt)]);
  assert.equal(await stock(sellerVariant, bdSeller), 3);
  assert.equal(await stock(storeVariant, bdStore), 1);
  assert.equal(await stock(storeVariant, usStore), 5);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus, "SHIPPED");
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId } })).status, "AWAITING_COLLECTION");
  const review = await codReconciliationOrder(owner, orderId);
  assert.equal(review?.canRecord, false);
  assert.equal(review.parcelReview, true);
  assert.ok((await listCodReconciliation(owner, "parcel-review", 1)).rows.some(row => row.id === orderId));
  assert.ok(!(await listCodReconciliation(owner, "awaiting-delivery", 1)).rows.some(row => row.id === orderId));
  assert.equal(await guestOrder(orderId, randomBytes(32).toString("hex")), null);
  const tracking = await db.orderParcel.findMany({ where: { orderId }, select: { status: true, trackingReference: true } });
  assert.deepEqual(new Set(tracking.map(parcel => `${parcel.status}/${parcel.trackingReference}`)), new Set(["DELIVERED/DH-PARCEL", "RETURNED/SELLER-PARCEL"]));
  const buyerOrder = await guestOrder(orderId, attempt.key);
  assert.equal(buyerOrder?.parcels.length, 2);
  assert.doesNotMatch(JSON.stringify(buyerOrder), /Synthetic (delivery evidence|refusal evidence|parcel physically returned)/);
  const reportRange = sellerOrderRange(undefined, undefined);
  assert.ok(reportRange);
  const sellerView = (await sellerOrderPage(shopId, reportRange, 1)).orders.find(order => order.id === orderId);
  assert.deepEqual(sellerView?.parcels.map(parcel => parcel.trackingReference), ["SELLER-PARCEL"]);
});

test("one line can split across local warehouses and COD collection waits for the last parcel", async t => {
  const { owner, packer, bdStore, backupBd, usStore, preparedCheckout } = await locationFixture(t);
  await db.locationInventory.create({ data: { variantId: storeVariant, locationId: backupBd, available: 1 } });
  const checkout = await preparedCheckout([{ variantId: storeVariant, quantity: 3 }]);
  const placed = await checkout.submit();
  assert.equal(placed.kind, "placed");
  const { orderId } = placed;
  const parcels = await db.orderParcel.findMany({ where: { orderId }, include: { items: true } });
  assert.equal(parcels.length, 2);
  const quantities = new Map(parcels.map(parcel => [parcel.locationId, parcel.items[0].quantity]));
  assert.equal(quantities.get(bdStore), 2);
  assert.equal(quantities.get(backupBd), 1);
  assert.equal(parcels[0].items[0].orderItemId, parcels[1].items[0].orderItemId);
  await prepareOrderParcels(packer, orderId);
  for (const [index, parcel] of parcels.entries()) {
    await dispatchOrderParcel(packer, orderId, parcel.id, { carrier: "Fixture courier", trackingReference: `LOCATION-QA-${index}` });
    await recordOrderParcelTracking(packer, orderId, parcel.id, { status: "DELIVERED", evidence: "Synthetic delivery evidence" });
    if (index === 0) await assert.rejects(collectCash(owner, orderId), /delivered/i);
  }
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus, "DELIVERED");
  await collectCash(owner, orderId);
  assert.equal((await db.payment.findUniqueOrThrow({ where: { orderId } })).status, "COLLECTED");
  assert.equal((await codReconciliationOrder(owner, orderId))?.canRecord, true);
  assert.equal(await stock(storeVariant, usStore), 5);
});

test("competing checkout attempts cannot oversell the local warehouse and cancellation restores the original allocation", async t => {
  const { owner, bdStore, usStore, preparedCheckout } = await locationFixture(t);
  const items = [{ variantId: storeVariant, quantity: 2 }];
  const [first, second] = await Promise.all([preparedCheckout(items), preparedCheckout(items)]);
  const outcomes = await Promise.all([first.submit(), second.submit()]);
  const placed = outcomes.filter(outcome => outcome.kind === "placed");
  assert.equal(placed.length, 1);
  assert.equal(await stock(storeVariant, bdStore), 0);
  assert.equal(await stock(storeVariant, usStore), 5);
  await cancelOrder(owner, placed[0].orderId);
  await cancelOrder(owner, placed[0].orderId);
  assert.equal(await stock(storeVariant, bdStore), 2);
  assert.equal(await stock(storeVariant, usStore), 5);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: storeVariant } })).available, 0);
});

test("a single-reference exchange leaves both locations unchanged when its replacement would need split parcels", async t => {
  const { owner, packer, sellerId, bdStore, backupBd, preparedCheckout } = await locationFixture(t);
  const replacementVariantId = "v-tee-sage-m";
  await db.locationInventory.createMany({ data: [bdStore, backupBd].map(locationId => ({ variantId: replacementVariantId, locationId, available: 1 })) });
  const checkout = await preparedCheckout([{ variantId: storeVariant, quantity: 2 }]);
  const placed = await checkout.submit(sellerId);
  assert.equal(placed.kind, "placed");
  const { orderId } = placed;
  const parcel = await db.orderParcel.findFirstOrThrow({ where: { orderId } });
  await prepareOrderParcels(packer, orderId);
  await dispatchOrderParcel(packer, orderId, parcel.id, { carrier: "Fixture courier", trackingReference: "EXCHANGE-ORIGINAL" });
  await recordOrderParcelTracking(packer, orderId, parcel.id, { status: "DELIVERED", evidence: "Synthetic delivery evidence" });
  await collectCash(owner, orderId);
  const orderItem = await db.orderItem.findFirstOrThrow({ where: { orderId } });
  const staff = { id: owner, role: "owner" } as const;
  const { id: caseId } = await executeOrderCase({ id: sellerId, role: "shopper" }, {
    action: "open", kind: "EXCHANGE", orderId, note: "Please exchange both units for the next size.",
    lines: [{ orderItemId: orderItem.id, quantity: 2, replacementVariantId }],
  });
  const review = { action: "review", caseId, note: "Review the requested sizes." } as const;
  await executeOrderCase(staff, { ...review, revision: 0, status: "IN_REVIEW" });
  await executeOrderCase(staff, { ...review, revision: 1, status: "RETURN_APPROVED" });
  await executeOrderCase(staff, { action: "receive", caseId, revision: 2, disposition: "RESTOCK", confirmed: true });
  await assert.rejects(executeOrderCase(staff, {
    action: "ship-exchange", caseId, revision: 3, trackingReference: "EXCHANGE-ONLY-ONE", note: "Record a replacement shipment.",
  }), { status: 409, message: /multiple dispatch locations/ });
  assert.equal(await stock(replacementVariantId, bdStore), 1);
  assert.equal(await stock(replacementVariantId, backupBd), 1);
  assert.equal((await db.orderCase.findUniqueOrThrow({ where: { id: caseId } })).status, "RETURN_RECEIVED");
});
