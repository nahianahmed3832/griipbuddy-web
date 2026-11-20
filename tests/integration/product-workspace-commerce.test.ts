import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { readProductWorkspaceCommerce, runWorkspaceStockCommand } from "../../src/lib/staff/product-workspace-commerce.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function fixture(t: TestContext) {
  const productId = `workspace-pools-${randomUUID().slice(0, 8)}`;
  const variantId = `v-${productId}`;
  const extraVariant = `v-${productId}-other`;
  const owner = { kind: "staff", id: `${productId}-owner` } as const;
  const marketStaff = { kind: "staff", id: `${productId}-market` } as const;
  const seller = { kind: "seller", id: `${productId}-shopper` } as const;
  const shopId = randomUUID();
  const warehouse = `${productId}-shared`;
  const sellerWarehouse = `${productId}-seller`;
  const priorMarketplace = process.env.GRIIP_MARKETPLACE_PREVIEW;
  const priorFirstParty = process.env.GRIIP_FIRST_PARTY_STOREFRONT;
  process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
  delete process.env.GRIIP_FIRST_PARTY_STOREFRONT;

  t.after(async () => {
    if (priorMarketplace === undefined) delete process.env.GRIIP_MARKETPLACE_PREVIEW;
    else process.env.GRIIP_MARKETPLACE_PREVIEW = priorMarketplace;
    if (priorFirstParty === undefined) delete process.env.GRIIP_FIRST_PARTY_STOREFRONT;
    else process.env.GRIIP_FIRST_PARTY_STOREFRONT = priorFirstParty;
    await db.inventoryMovement.deleteMany({ where: { pool: { variant: { productId } } } });
    await db.inventoryPool.deleteMany({ where: { variant: { productId } } });
    await db.marketOffer.deleteMany({ where: { variant: { productId } } });
    await db.marketOfferIdentity.deleteMany({ where: { variant: { productId } } });
    await db.variant.deleteMany({ where: { productId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.dispatchLocationMarket.deleteMany({ where: { locationId: { in: [warehouse, sellerWarehouse] } } });
    await db.dispatchLocation.deleteMany({ where: { id: { in: [warehouse, sellerWarehouse] } } });
    await db.marketplaceShop.deleteMany({ where: { id: shopId } });
    await db.shopper.deleteMany({ where: { id: seller.id } });
    await db.auditEvent.deleteMany({ where: { target: { in: [productId, variantId, extraVariant, warehouse, sellerWarehouse] } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, marketStaff.id] } } });
  });

  for (const [actor, role] of [[owner, "OWNER"], [marketStaff, "PACKER"]] as const) {
    await db.user.create({ data: { id: actor.id, name: "Workspace fixture", email: `${actor.id}@example.invalid`, staff: { create: { role } } } });
  }
  await db.staffMarketAccess.create({ data: { userId: marketStaff.id, marketId: "bd", commercial: true } });
  await db.shopper.create({ data: { id: seller.id, name: "Workspace seller", email: `${seller.id}@example.invalid` } });
  await db.marketplaceShop.create({ data: {
    id: shopId, ownerId: seller.id, slug: `${productId}-shop`, published: true, name: "Workspace seller",
    about: "", announcement: "", marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
  } });
  await db.dispatchLocation.createMany({ data: [
    { id: warehouse, name: "Shared workspace warehouse", marketId: "bd" },
    { id: sellerWarehouse, name: "Seller workspace warehouse", marketId: "bd", shopId },
  ] });
  const department = await db.department.findFirstOrThrow();
  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: department.id, foundation: true, name: "Workspace stock fixture",
    description: "", specifications: [], keywords: [], addedOn: new Date(), position: 0, publication: "ACTIVE",
    variants: { create: [variantId, extraVariant].map((id, index) => ({ id, sku: id.toUpperCase(),
      options: {}, label: `Variant ${index + 1}`, position: index, optionSignature: index ? '["other"]' : "[]", isDefault: index === 0,
    })) },
  } });
  return { productId, variantId, extraVariant, owner, marketStaff, seller, shopId, warehouse, sellerWarehouse };
}

const route = { active: true, priority: 10, districts: [], methods: [] };

test("workspace stock shares one pool across markets, enforces stale receipts and preserves reservations", async t => {
  const f = await fixture(t);
  const scope = { productId: f.productId, marketId: "bd" };
  await runWorkspaceStockCommand(f.owner, "inventory.route", { ...scope, locationId: f.warehouse, expected: null, ...route });
  await assert.rejects(runWorkspaceStockCommand(f.owner, "inventory.route", { ...scope, locationId: f.warehouse,
    expected: null, ...route }), /service changed/);
  await runWorkspaceStockCommand(f.owner, "inventory.route", { ...scope, marketId: "us", locationId: f.warehouse, expected: null, ...route });
  const initialize = { ...scope, variantId: f.variantId, locationId: f.warehouse };
  await runWorkspaceStockCommand(f.owner, "inventory.initialize", initialize);
  await runWorkspaceStockCommand(f.owner, "inventory.initialize", { ...initialize, marketId: "us" });
  const pool = await db.inventoryPool.findUniqueOrThrow({
    where: { variantId_ownerId_locationId: { variantId: f.variantId, ownerId: storeShop.id, locationId: f.warehouse } },
  });
  const receipt = { ...scope, poolId: pool.id, kind: "RECEIPT", quantity: 5, expectedUpdatedAt: pool.updatedAt.toISOString(),
    reason: "Counted workspace stock", reference: "private-supplier-example", idempotencyKey: "stock-workspace-fixture" };
  await runWorkspaceStockCommand(f.owner, "inventory.movement", receipt);
  await runWorkspaceStockCommand(f.owner, "inventory.movement", receipt);
  assert.equal(await db.inventoryMovement.count({ where: { poolId: pool.id } }), 1);
  await assert.rejects(runWorkspaceStockCommand(f.owner, "inventory.movement", { ...receipt,
    idempotencyKey: "stale-workspace-stock", expectedUpdatedAt: new Date(0).toISOString() }), { code: "conflict" });
  await assert.rejects(runWorkspaceStockCommand(f.marketStaff, "inventory.movement", receipt), { code: "forbidden" });

  const held = await db.inventoryPool.update({ where: { id: pool.id }, data: { reserved: 3 } });
  await assert.rejects(runWorkspaceStockCommand(f.owner, "inventory.movement", { ...receipt, kind: "ADJUSTMENT",
    quantity: -3, expectedUpdatedAt: held.updatedAt.toISOString(), idempotencyKey: "reserved-stock" }), /available stock/);

  for (const market of ["bd", "us"] as const) {
    const view = await readProductWorkspaceCommerce(f.owner, f.productId, market);
    assert.equal(view?.data?.pools.length, 1);
    assert.equal(view?.data?.pools[0].id, pool.id);
    assert.deepEqual(view?.data?.pools[0].warehouse.servingMarkets, ["bd", "us"]);
    assert.deepEqual([view?.data?.pools[0].onHand, view?.data?.pools[0].reserved, view?.data?.pools[0].available], [5, 3, 2]);
    assert.equal(view?.data?.movements.length, 1);
    assert.doesNotMatch(JSON.stringify(view?.data), /private-supplier-example/);
  }
  const scoped = await readProductWorkspaceCommerce(f.marketStaff, f.productId, "bd");
  assert.equal(scoped?.data?.hasRestrictedPools, true);
  assert.deepEqual(scoped?.data?.pools, []);
  assert.equal((await readProductWorkspaceCommerce(f.marketStaff, f.productId, "us"))?.data, null);
});

test("a seller sees assigned offers and attributable pools without another seller’s variants or terms", async t => {
  const f = await fixture(t);
  const scope = { productId: f.productId, marketId: "bd" };
  const read = () => readProductWorkspaceCommerce(f.seller, f.productId, "bd");
  assert.equal(await read(), null);
  const input = { marketId: "bd", expectedRevision: null, currency: "BDT", publication: "ACTIVE", eligible: true };
  await saveConnectedOffer(f.owner, { ...input, variantId: f.variantId, sellerId: f.shopId, amountMinor: 129900 });
  await saveConnectedOffer(f.owner, { ...input, variantId: f.extraVariant, sellerId: storeShop.id, amountMinor: 299900 });
  await runWorkspaceStockCommand(f.seller, "inventory.route", { ...scope, locationId: f.sellerWarehouse, expected: null, ...route });
  await runWorkspaceStockCommand(f.seller, "inventory.initialize", { ...scope, locationId: f.sellerWarehouse, variantId: f.variantId });
  await assert.rejects(runWorkspaceStockCommand(f.seller, "inventory.initialize", {
    ...scope, locationId: f.sellerWarehouse, variantId: f.extraVariant,
  }), { code: "forbidden" });
  const view = await read();
  assert.deepEqual(view?.data?.variants.map(variant => variant.id), [f.variantId]);
  assert.equal(view?.data?.variants[0].offer?.amountMinor, 129900);
  assert.deepEqual(view?.data?.pools.map(pool => pool.ownerId), [f.shopId]);
  assert.doesNotMatch(JSON.stringify(view?.data), /299900/);
  assert.equal((await readProductWorkspaceCommerce(f.seller, f.productId, "us"))?.data, null);
});
