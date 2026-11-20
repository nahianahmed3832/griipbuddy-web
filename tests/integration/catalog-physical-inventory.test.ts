import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import type { MarketId } from "../../src/config/markets.ts";
import { getMarketProductFoundation } from "../../src/lib/catalog/product-foundation.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import type { CommercialActor } from "../../src/lib/commerce/commercial-access.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { getOfferFulfilment } from "../../src/lib/commerce/offer-fulfilment.ts";
import { reviewCheckout } from "../../src/lib/commerce/orders.ts";
import {
  eligibleInventoryPools, initializeInventoryPool, inventoryPoolScopeKey, marketRoutedInventory, recordStockMovement, saveWarehouseService, transferStock,
} from "../../src/lib/commerce/physical-inventory.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { adjustLocationStock } from "../../src/lib/staff/location-inventory.ts";
import { updatePrice } from "../../src/lib/staff/operations.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

const staff = (id: string): CommercialActor => ({ kind: "staff", id });
const seller = (id: string): CommercialActor => ({ kind: "seller", id });

async function fixture(t: TestContext) {
  const nonce = randomUUID().slice(0, 8);
  const prefix = `fixture-physical-${nonce}`;
  const variantId = `v-${prefix}`;
  const method = `ground-${nonce}`;
  const shared = `${prefix}-mixed`;
  const domestic = `${prefix}-domestic`;
  const other = `${prefix}-other`;
  const staffOwner = `${prefix}-owner`;
  const staffMarket = `${prefix}-market`;
  const operationsOnly = `${prefix}-operations`;
  const sellerId = randomUUID();
  const shopperId = randomUUID();
  const beforeEnv = process.env.GRIIP_MARKET_CONFIGURATION;
  const beforeMarketplace = process.env.GRIIP_MARKETPLACE_PREVIEW;
  const beforeFirstParty = process.env.GRIIP_FIRST_PARTY_STOREFRONT;
  const priorPolicies = await db.checkoutPolicy.findMany();
  t.after(async () => {
    if (beforeEnv === undefined) delete process.env.GRIIP_MARKET_CONFIGURATION;
    else process.env.GRIIP_MARKET_CONFIGURATION = beforeEnv;
    if (beforeMarketplace === undefined) delete process.env.GRIIP_MARKETPLACE_PREVIEW;
    else process.env.GRIIP_MARKETPLACE_PREVIEW = beforeMarketplace;
    if (beforeFirstParty === undefined) delete process.env.GRIIP_FIRST_PARTY_STOREFRONT;
    else process.env.GRIIP_FIRST_PARTY_STOREFRONT = beforeFirstParty;
    await db.inventoryMovement.deleteMany({ where: { pool: { variantId } } });
    await db.inventoryPool.deleteMany({ where: { variantId } });
    await db.marketOffer.deleteMany({ where: { variant: { productId: prefix } } });
    await db.marketOfferIdentity.deleteMany({ where: { variant: { productId: prefix } } });
    await db.dispatchLocationMarket.deleteMany({ where: { locationId: { startsWith: prefix } } });
    await db.inventory.deleteMany({ where: { variant: { productId: prefix } } });
    await db.variant.deleteMany({ where: { productId: prefix } });
    await db.product.deleteMany({ where: { id: prefix } });
    await db.auditEvent.deleteMany({ where: { target: { startsWith: prefix } } });
    await db.dispatchLocation.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.marketplaceShopMarket.deleteMany({ where: { shopId: sellerId } });
    await db.marketplaceShop.deleteMany({ where: { id: sellerId } });
    await db.shopper.deleteMany({ where: { id: shopperId } });
    await db.user.deleteMany({ where: { id: { in: [staffOwner, staffMarket, operationsOnly] } } });
    await db.deliveryZone.deleteMany({ where: { method } });
    for (const prior of priorPolicies) {
      await db.checkoutPolicy.update({ where: { marketId: prior.marketId }, data: {
        enabled: prior.enabled, codEnabled: prior.codEnabled, taxTreatment: prior.taxTreatment,
        taxBasisPoints: prior.taxBasisPoints, taxLabel: prior.taxLabel,
      } });
    }
  });

  process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
  delete process.env.GRIIP_FIRST_PARTY_STOREFRONT;
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({
    us: {
      delivery: { coverage: "checkout-policy" },
      pricing: { priceList: "us-retail", taxTreatment: "MERCHANDISE_RATE", rounding: "minor-half-up" },
      payments: [{ method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true }],
    },
  });
  await db.checkoutPolicy.updateMany({ data: {
    enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 0, taxLabel: "Test tax",
  } });
  await db.deliveryZone.createMany({ data: [
    { marketId: "bd", district: "dhaka", districtLabel: "Dhaka", method, label: "Test dispatch", chargeMinor: 0 },
    { marketId: "bd", district: "rajshahi", districtLabel: "Rajshahi", method, label: "Test dispatch", chargeMinor: 0 },
    { marketId: "us", district: "wa", districtLabel: "Washington", method, label: "Test dispatch", chargeMinor: 0 },
    { marketId: "us", district: "ak", districtLabel: "Alaska", method, label: "Test dispatch", chargeMinor: 0 },
  ] });
  await db.user.createMany({ data: [staffOwner, staffMarket, operationsOnly].map(id => ({
    id, name: "Inventory fixture staff", email: `${id}@example.invalid`,
  })) });
  await db.staffAccess.createMany({ data: [
    { userId: staffOwner, role: "OWNER" }, { userId: staffMarket, role: "PACKER" }, { userId: operationsOnly, role: "PACKER" },
  ] });
  await db.staffMarketAccess.createMany({ data: [
    { userId: staffMarket, marketId: "bd", commercial: true }, { userId: operationsOnly, marketId: "bd", operations: true },
  ] });
  await db.shopper.create({ data: { id: shopperId, email: `${prefix}-seller@example.invalid`, name: "Inventory fixture seller" } });
  await db.marketplaceShop.create({ data: {
    id: sellerId, ownerId: shopperId, slug: `${prefix}-seller`, name: "Fixture shop", about: "", announcement: "", published: true,
    marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
  } });
  await db.dispatchLocation.createMany({ data: [
    { id: shared, name: "Cross-market warehouse", marketId: "bd" },
    { id: domestic, name: "Bangladesh-only warehouse", marketId: "bd" },
    { id: other, name: "Seller warehouse", marketId: "bd", shopId: sellerId },
  ] });
  const department = await db.department.findFirstOrThrow();
  await db.product.create({ data: {
    id: prefix, slug: prefix, departmentId: department.id, foundation: true, name: "Inventory fixture",
    description: "One SKU and several scoped warehouses", specifications: [], keywords: [], addedOn: new Date(),
    position: 1, publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId.toUpperCase(), options: {}, label: "Standard", position: 0,
      optionSignature: "[]", isDefault: true } },
  } });

  const owner = staff(staffOwner);
  const market = staff(staffMarket);
  const read = (marketId: MarketId, options?: { ownerId?: string; district?: string; postalCode?: string }) =>
    eligibleInventoryPools(db, {
      variantId, marketId, ownerId: options?.ownerId ?? storeShop.id, paymentMethod: "COD", destination: {
        country: marketId === "us" ? "US" : "BD",
        district: options?.district ?? (marketId === "us" ? "wa" : "dhaka"), method,
        postalCode: options?.postalCode ?? (marketId === "us" ? "98101" : undefined),
      },
    });
  const enable = (locationId: string, marketId: MarketId, districts: string[]) =>
    saveWarehouseService(owner, { locationId, marketId, active: true, priority: 25, districts, methods: [method] });
  return { owner, market, operationsOnly: staff(operationsOnly), merchant: seller(shopperId), sellerId,
    variantId, method, shared, domestic, other, read, enable };
}

const move = { idempotencyKey: "receipt-1", reason: "Counted fixture stock", reference: "supplier-delivery-1" };

test("market service edges share owned stock and distinguish route coverage from stock exhaustion", async t => {
  const { owner, merchant, sellerId, variantId, shared, domestic, other, read, enable } = await fixture(t);
  await enable(shared, "bd", ["dhaka"]);
  await enable(shared, "us", ["wa"]);
  await enable(domestic, "bd", ["dhaka"]);
  await enable(other, "bd", ["dhaka"]);
  const sharedPool = await initializeInventoryPool(owner, { variantId, locationId: shared });
  const domesticPool = await initializeInventoryPool(owner, { variantId, locationId: domestic });
  const merchantPool = await initializeInventoryPool(merchant, { variantId, locationId: other });
  assert.equal((await initializeInventoryPool(owner, { variantId, locationId: shared })).id, sharedPool.id);
  assert.equal(await db.inventoryPool.count({ where: { variantId, locationId: shared } }), 1);
  assert.equal((await read("us")).kind, "out_of_stock");
  assert.equal((await read("us", { district: "ak" })).kind, "delivery_unavailable");
  assert.equal((await read("us", { postalCode: "1200" })).kind, "delivery_unavailable");
  assert.equal((await read("bd", { district: "rajshahi" })).kind, "delivery_unavailable");

  for (const [pool, actor, quantity] of [[sharedPool, owner, 2], [domesticPool, owner, 3], [merchantPool, merchant, 5]] as const) {
    await recordStockMovement(actor, { ...move, poolId: pool.id, kind: "RECEIPT", quantity });
  }
  const bd = await read("bd");
  const us = await read("us");
  assert.equal(bd.available, 5);
  assert.equal(us.available, 2);
  assert.deepEqual(us.pools.map(pool => pool.id), [sharedPool.id]);
  assert.equal((await read("bd", { ownerId: sellerId })).available, 5);
  assert.equal((await read("us", { ownerId: sellerId })).kind, "delivery_unavailable");
  await enable(shared, "bd", ["dhaka", "rajshahi"]);
  const store = { variantId, ownerId: storeShop.id };
  const vendor = { variantId, ownerId: sellerId };
  const [bdMerchandising, usMerchandising] = await Promise.all([
    marketRoutedInventory(db, "bd", [store, store, vendor]), marketRoutedInventory(db, "us", [store, vendor]),
  ]);
  assert.equal(bdMerchandising.get(inventoryPoolScopeKey(store)), 5, "Each physical pool is counted once across delivery routes.");
  assert.equal(bdMerchandising.get(inventoryPoolScopeKey(vendor)), 5);
  assert.equal(usMerchandising.get(inventoryPoolScopeKey(store)), 2, "The second market uses the same pool.");
  assert.equal(usMerchandising.has(inventoryPoolScopeKey(vendor)), false);
  process.env.GRIIP_FIRST_PARTY_STOREFRONT = "1";
  assert.equal((await read("bd", { ownerId: sellerId })).kind, "delivery_unavailable");
  assert.equal(await db.inventory.count({ where: { variantId } }), 0);
  assert.equal(await db.locationInventory.count({ where: { variantId } }), 0);
});

test("stock authority rejects cross-market and cross-owner mutations and legacy overlap", async t => {
  const { owner, market, operationsOnly, merchant, variantId, shared, domestic, other, enable } = await fixture(t);
  await enable(shared, "bd", ["dhaka"]);
  await enable(shared, "us", ["wa"]);
  await enable(domestic, "bd", ["dhaka"]);
  await enable(other, "bd", ["dhaka"]);
  await assert.rejects(enable(other, "us", ["wa"]), /not approved/);
  await assert.rejects(saveWarehouseService(market, { locationId: domestic, marketId: "us", active: true, priority: 25 }), /commercial permission/);
  await assert.rejects(initializeInventoryPool(market, { variantId, locationId: shared }), /commercial permission/);
  await assert.rejects(initializeInventoryPool(operationsOnly, { variantId, locationId: domestic }), /commercial permission/);
  const onlyBd = await initializeInventoryPool(market, { variantId, locationId: domestic });
  await assert.rejects(recordStockMovement(merchant, { ...move, poolId: onlyBd.id, kind: "RECEIPT", quantity: 1 }), /Seller access/);
  const sellerPool = await initializeInventoryPool(merchant, { variantId, locationId: other });
  await assert.rejects(transferStock(owner, { ...move, fromPoolId: onlyBd.id, toPoolId: sellerPool.id, quantity: 1 }), /same owner and SKU/);
  const newVariant = `${variantId}-legacy`;
  const parent = await db.variant.findUniqueOrThrow({ where: { id: variantId }, select: { productId: true } });
  await db.variant.create({ data: { id: newVariant, productId: parent.productId, sku: newVariant.toUpperCase(), label: "Migration fixture",
    options: {}, optionSignature: '[["size","m"]]', position: 1, inventory: { create: { available: 4 } } } });
  await assert.rejects(initializeInventoryPool(owner, { variantId: newVariant, locationId: domestic }), /Reconcile legacy inventory/);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: newVariant } })).available, 4);
  const legacyOfferVariantId = `${variantId}-legacy-offer`;
  await db.variant.create({ data: { id: legacyOfferVariantId, productId: parent.productId, sku: legacyOfferVariantId.toUpperCase(),
    label: "Legacy offer fixture", options: {}, optionSignature: '[["size","l"]]', position: 2,
    offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 10_000 } } } });
  await assert.rejects(initializeInventoryPool(owner, { variantId: legacyOfferVariantId, locationId: domestic }), /Reconcile legacy market offers/);
  assert.equal((await db.variant.findUniqueOrThrow({ where: { id: legacyOfferVariantId } })).managedInventory, false);
});

test("receipts, adjustments and paired transfers apply once, with a rollback when stock is reserved", async t => {
  const { owner, variantId, shared, domestic, enable } = await fixture(t);
  await enable(shared, "bd", ["dhaka"]);
  await enable(domestic, "bd", ["dhaka"]);
  const origin = await initializeInventoryPool(owner, { variantId, locationId: shared });
  const target = await initializeInventoryPool(owner, { variantId, locationId: domestic });
  const receipt = { ...move, poolId: origin.id, kind: "RECEIPT", quantity: 4 };
  const created = await recordStockMovement(owner, receipt);
  assert.equal(created.replayed, false);
  assert.deepEqual(await recordStockMovement(owner, receipt), { movement: created.movement, replayed: true });
  await assert.rejects(recordStockMovement(owner, { ...receipt, quantity: 5 }), /different event/);
  await assert.rejects(recordStockMovement(owner, { ...receipt, kind: "RETURN" }), /kind/);
  await db.inventoryPool.update({ where: { id: origin.id }, data: { reserved: 3 } });
  await assert.rejects(transferStock(owner, { ...move, idempotencyKey: "transfer-1", fromPoolId: origin.id, toPoolId: target.id, quantity: 2 }),
    /exceed available stock/);
  assert.equal(await db.inventoryMovement.count({ where: { pool: { variantId } } }), 1);
  const transfer = { ...move, idempotencyKey: "transfer-1", reason: "Route rebalancing", fromPoolId: origin.id, toPoolId: target.id, quantity: 1 };
  const pair = await transferStock(owner, transfer);
  assert.equal(pair.replayed, false);
  assert.deepEqual(await transferStock(owner, transfer), { ...pair, replayed: true });
  await assert.rejects(transferStock(owner, { ...transfer, fromPoolId: target.id, toPoolId: origin.id }), /different event/);
  const beforeAdjustment = await db.inventoryPool.findUniqueOrThrow({ where: { id: origin.id } });
  assert.deepEqual([beforeAdjustment.onHand, beforeAdjustment.reserved], [3, 3]);
  const adjustment = { ...move, idempotencyKey: "count-2", reason: "Found one unit during count", poolId: target.id, kind: "ADJUSTMENT", quantity: 1 };
  assert.equal((await recordStockMovement(owner, adjustment)).replayed, false);
  assert.equal((await recordStockMovement(owner, adjustment)).replayed, true);
  const row = await db.inventoryPool.findUniqueOrThrow({ where: { id: target.id } });
  assert.deepEqual([row.onHand, row.reserved], [2, 0]);
  assert.equal(await db.inventoryMovement.count({ where: { pool: { variantId } } }), 4);
});

test("connected quotes show local terms and coverage while legacy purchase and price paths stay isolated", async t => {
  const { owner, variantId, method, shared, enable } = await fixture(t);
  await enable(shared, "bd", ["dhaka"]);
  await enable(shared, "us", ["wa"]);
  const pool = await initializeInventoryPool(owner, { variantId, locationId: shared });
  const base = { variantId, sellerId: storeShop.id, publication: "ACTIVE", expectedRevision: null, eligible: true } as const;
  const bd = await saveConnectedOffer(owner, { ...base, marketId: "bd", amountMinor: 129_000 });
  const us = await saveConnectedOffer(owner, { ...base, marketId: "us", amountMinor: 1999 });
  const arrival = { country: "US", district: "wa", postalCode: "98101", method };
  const delivery = { paymentMethod: "COD", destination: arrival };
  const quote = { variantId, marketId: "us", delivery };
  assert.equal((await getOfferFulfilment({ variantId, marketId: "us" })).kind, "browse_only");
  const exhausted = await getOfferFulfilment(quote);
  assert.equal(exhausted.kind, "out_of_stock");
  if (exhausted.kind === "out_of_stock") {
    assert.deepEqual([exhausted.offer.id, exhausted.offer.currency, exhausted.offer.amountMinor], [us.id, "USD", 1999]);
    assert.equal(exhausted.available, 0);
  }
  assert.equal((await getOfferFulfilment({ ...quote, delivery: { ...delivery, destination: { ...arrival, district: "ak" } } }))
    .kind, "delivery_unavailable");
  await recordStockMovement(owner, { ...move, poolId: pool.id, kind: "RECEIPT", quantity: 1 });
  assert.equal((await getOfferFulfilment(quote)).kind, "available");
  assert.equal((await getOfferFulfilment({ ...quote, delivery: { ...delivery, quantity: 2 } })).kind, "out_of_stock");
  const local = await getOfferFulfilment({ variantId, marketId: "bd", delivery: {
    paymentMethod: "COD", destination: { country: "BD", district: "dhaka", method },
  } });
  assert.equal(local.kind, "available");
  if (local.kind === "available") {
    assert.deepEqual([local.offer.id, local.offer.currency, local.offer.amountMinor], [bd.id, "BDT", 129_000]);
    assert.equal(local.available, 1);
  }
  const { productId } = await db.variant.findUniqueOrThrow({ where: { id: variantId }, select: { productId: true } });
  assert.equal((await getMarketProductFoundation(productId, "bd", "en-BD"))?.defaultVariantId, variantId);
  assert.deepEqual(await catalog.resolveVariants([variantId], "bd"), []);
  await assert.rejects(updatePrice(owner.id, { variantId, marketId: "bd", expectedMinor: 129_000, amountMinor: 140_000 }), /market offer editor/);
  await assert.rejects(adjustLocationStock(owner.id, {
    variantId, locationId: shared, delta: 1, reason: "Legacy writer test",
  }), /owner and warehouse inventory/);
  const legacy = await reviewCheckout({
    marketId: "bd", paymentMethod: "COD", deliveryMethod: method,
    customer: { name: "Fixture Customer", phone: "01700000000", district: "dhaka", locality: "Fixture", address: "Fixture address" },
    items: [{ variantId, quantity: 1 }],
  }, "bd", randomBytes(32).toString("hex"));
  assert.equal(legacy.kind, "unavailable");
  const priorRecovered = process.env.GRIIP_RECOVERED_CHECKOUT;
  process.env.GRIIP_RECOVERED_CHECKOUT = "http://127.0.0.1:38199";
  try {
    assert.equal((await getOfferFulfilment({ variantId, marketId: "bd", delivery: {
      paymentMethod: "COD", destination: { country: "BD", district: "dhaka", method },
    } })).kind, "delivery_unavailable");
  } finally {
    if (priorRecovered === undefined) delete process.env.GRIIP_RECOVERED_CHECKOUT;
    else process.env.GRIIP_RECOVERED_CHECKOUT = priorRecovered;
  }
});
