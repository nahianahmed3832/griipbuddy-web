import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { listConnectedCatalog } from "../../src/lib/catalog/connected-listing.ts";
import type { CatalogReadContext } from "../../src/lib/catalog/connected-public.ts";
import { applyCatalogMigration, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { recordStockMovement } from "../../src/lib/commerce/physical-inventory.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { createCatalogMigrationFixture } from "./catalog-migration-fixture.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());
const bd = { marketId: "bd", locale: "en-BD" } satisfies CatalogReadContext;
const us = { marketId: "us", locale: "en-US" } satisfies CatalogReadContext;
const now = new Date("2026-11-19T15:00:00Z");

async function fixture(t: TestContext) {
  const original = await createCatalogMigrationFixture(db);
  const runIds: string[] = [];
  const ownerId = `${original.key}-listing-owner`;
  const group = `${original.key}-fixture-collection`;
  const magnetic = `${original.key}-magnetic`;
  const thickness = `${original.key}-thickness`;
  const beforeFlag = process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
  process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
  t.after(async () => {
    try {
      await db.categoryAttributeTemplate.deleteMany({ where: { attributeId: { in: [magnetic, thickness] } } });
      await db.catalogAttributeDefinition.deleteMany({ where: { id: { in: [magnetic, thickness] } } });
      await db.collection.deleteMany({ where: { id: group } });
      await db.auditEvent.deleteMany({ where: { actorId: ownerId } });
      await original.cleanup(runIds);
      await db.user.deleteMany({ where: { id: ownerId } });
    } finally {
      if (beforeFlag === undefined) delete process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
      else process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = beforeFlag;
    }
  });
  const read = (query: Record<string, string> | [string, string][] = {}, context: CatalogReadContext = bd,
    browsePage?: number) => {
    const params = new URLSearchParams(query);
    if (!params.has("category")) params.set("category", original.categories.departmentId);
    return listConnectedCatalog(params, context, db, now, browsePage === undefined ? undefined : { browsePage });
  };
  const apply = async () => {
    const plan = await dryRunCatalogMigration(original.manifest);
    runIds.push(plan.digest);
    await applyCatalogMigration(plan);
  };
  return { ...original, read, apply, ownerId, group, magnetic, thickness };
}

test("ancestor browsing groups legacy identifiers, verified combinations and a shared SKU using exact regional prices", async t => {
  const f = await fixture(t);
  const legacy = await f.read({ category: f.categories.travelLeafId, color: "Blue" });
  assert.equal(legacy.total, 1);
  assert.equal(legacy.items[0].id, f.caseSourceProductId);
  assert.equal(legacy.items[0].representative.offer.id, null);
  assert.equal(legacy.items[0].representative.availability, "browse_only");
  const native = { category: f.categories.casesLeafId, availability: "available" };
  const stock = await f.read(native, bd, 1);
  assert.equal(stock.total, 1);
  assert.equal(stock.items[0].representative.availability, "available");
  const location = { variantId_locationId: { variantId: f.caseVariantId, locationId: f.locationId } };
  await db.locationInventory.update({ where: location, data: { available: 0 } });
  const soldOut = await f.read(native, bd, 1);
  assert.equal(soldOut.total, 0);
  assert.deepEqual(soldOut.browse?.removed, []);
  assert.equal(soldOut.browse?.facets.find(facet => facet.id === "availability")?.values.find(choice => choice.value === "available")?.count, 0);
  await db.locationInventory.update({ where: location, data: { available: f.stock.case } });

  await f.apply();
  const browse = await f.read();
  assert.equal(browse.total, 2);
  assert.deepEqual(browse.items.map(row => row.id), [f.caseProductId, f.accessoryProductId]);
  assert.deepEqual(browse.items[0].matchingVariantIds, [f.caseVariantId, f.caseSourceVariantId]);
  assert.equal(browse.items[0].matchedVariantId, null);
  assert.deepEqual(browse.facets.brand, [{ value: "fixture devices", label: "Fixture Devices", count: 2 }]);
  assert.deepEqual(browse.facets.color.map(({ label, count }) => [label, count]), [["Black", 1], ["Blue", 1]]);

  assert.equal((await f.read({ model: "Phone A", color: "Blue" })).total, 0);
  assert.equal((await f.read({ model: "Phone B", color: "Blue", maxMinor: "2200" }, us)).total, 0);
  assert.equal((await f.read({ model: "Phone B", color: "Blue", design: "Plain" })).total, 0);
  const results = await f.read({ model: "Phone B", color: "Blue", design: "Floral", sale: "true" }, us);
  assert.equal(results.total, 1);
  const [match] = results.items;
  assert.equal(match.matchedVariantId, f.caseSourceVariantId);
  assert.deepEqual(match.matchingVariantIds, [f.caseSourceVariantId]);
  assert.ok(match.representative.offer.id);
  assert.deepEqual(match.representative.image, { src: "/catalog/headphones-taupe.webp", alt: "Blue fixture version" });
  assert.deepEqual(match.fromPrice, { currency: "USD", amountMinor: f.prices.caseSource.us - 200, maxAmountMinor: f.prices.caseSource.us - 200 });
  assert.equal(match.representative.offer.regularMinor, f.prices.caseSource.us);
  assert.equal((await f.read({ q: f.caseSourceSku })).items[0].matchedVariantId, f.caseSourceVariantId);
  assert.equal((await f.read({ model: f.modelIds[1] })).items[0].representative.variantId, f.accessoryVariantId);
  assert.equal((await f.read({ model: f.modelAliasKeys[1] })).items[0].id, f.accessoryProductId);
});

test("listing combines typed inherited attributes, options and collections and scopes cursors to stable results", async t => {
  const f = await fixture(t);
  await f.apply();
  await db.catalogAttributeDefinition.createMany({ data: [
    { id: f.magnetic, name: "Magnetic", scope: "VARIANT", dataType: "BOOLEAN" },
    { id: f.thickness, name: "Thickness", scope: "PRODUCT", dataType: "NUMBER" },
  ] });
  await db.categoryAttributeTemplate.createMany({ data: [f.magnetic, f.thickness].map(attributeId => ({
    departmentId: f.categories.departmentId, attributeId, filterable: true, inheritable: true,
  })) });
  await db.product.update({ where: { id: f.caseProductId }, data: { attributeValues: { [f.thickness]: 3 } } });
  await db.variant.update({ where: { id: f.caseVariantId }, data: { attributeValues: { [f.magnetic]: false } } });
  await db.variant.update({ where: { id: f.caseSourceVariantId }, data: { attributeValues: { [f.magnetic]: true } } });
  await db.collection.create({ data: { id: f.group, slug: f.group, name: "Selection", description: "", position: 0,
    products: { create: { productId: f.caseProductId } } } });

  assert.equal((await f.read({ color: "Black", attribute: `${f.magnetic}:true` })).total, 0);
  assert.equal((await f.read({ attribute: `${f.thickness}:"3"` })).total, 0);
  const typed = await f.read([
    ["attribute", `${f.magnetic}:true`], ["attribute", `${f.thickness}:3`], ["collection", f.group], ["option", "design:Floral"],
  ]);
  assert.equal(typed.total, 1);
  assert.equal(typed.collectionId, f.group);
  assert.equal(typed.items[0].matchedVariantId, f.caseSourceVariantId);
  assert.deepEqual(typed.facets.attributes.find(attribute => attribute.id === f.magnetic)?.values, [{ value: true, label: "true", count: 1 }]);
  const [option] = typed.items[0].representative.options.filter(option => option.key === "Design" || option.key === "design");
  assert.ok(option.optionId && option.valueId);
  assert.equal((await f.read({ option: `${option.optionId}:${option.valueId}` })).items[0].matchedVariantId, f.caseSourceVariantId);

  const query = { limit: "1", sort: "price-low" };
  const first = await f.read(query);
  assert.equal(first.items[0].id, f.accessoryProductId);
  assert.ok(first.nextCursor);
  const page = await f.read({ ...query, cursor: first.nextCursor });
  assert.equal(page.items[0].id, f.caseProductId);
  assert.equal(page.total, first.total);
  assert.deepEqual(page.facets, first.facets);
  assert.equal(page.nextCursor, null);
  await assert.rejects(f.read({ ...query, cursor: first.nextCursor }, us), { status: 400, code: "invalid_cursor" });
  await assert.rejects(f.read({ ...query, cursor: first.nextCursor }, { ...bd, locale: "bn-BD" }), { status: 400, code: "invalid_cursor" });
  await assert.rejects(f.read({ ...query, cursor: first.nextCursor, brand: "Fixture Devices" }), { status: 400, code: "invalid_cursor" });
  await assert.rejects(f.read({ limit: "49" }), { status: 400, code: "invalid_filters" });
  await assert.rejects(f.read([["limit", "1"], ["limit", "2"]]), { status: 400, code: "invalid_filters" });

  await db.product.update({ where: { id: f.accessoryProductId }, data: { publication: "ARCHIVED" } });
  await assert.rejects(f.read({ ...query, cursor: first.nextCursor }), { status: 409, code: "catalog_changed" });
});

test("listing uses routed stock and reprices immediately after audited offer and inventory writes", async t => {
  const f = await fixture(t);
  await f.apply();
  const destination = { country: "BD", district: "dhaka", method: "standard" };
  const delivery = { destination, paymentMethod: "COD", quantity: 1 } as const;
  const context = { ...bd, delivery };
  const filters = { category: f.categories.casesLeafId };
  const first = await f.read(filters, context);
  assert.equal(first.items[0].representative.availability, "available");
  assert.equal(first.items[0].representative.variantId, f.caseVariantId);
  assert.equal((await f.read(filters)).items[0].representative.availability, "browse_only");
  assert.equal((await f.read(filters, { ...bd, delivery: { ...delivery, destination: { ...destination, district: "unserved" } } }))
    .items[0].representative.availability, "delivery_unavailable");

  await db.user.create({ data: { id: f.ownerId, name: "Fixture operator", email: `${f.ownerId}@example.invalid`,
    staff: { create: { role: "OWNER" } } } });
  const actor = { kind: "staff", id: f.ownerId } as const;
  const pool = await db.inventoryPool.findFirstOrThrow({ where: { variantId: f.caseVariantId, locationId: f.locationId } });
  await recordStockMovement(actor, { poolId: pool.id, kind: "ADJUSTMENT", quantity: -pool.onHand,
    idempotencyKey: "fixture-physical-count", reason: "Fixture physical count", reference: "fixture-count-v1" });
  const afterStock = await f.read(filters, context);
  assert.equal(afterStock.items[0].representative.variantId, f.caseSourceVariantId);
  assert.equal(afterStock.items[0].fromPrice?.amountMinor, f.prices.caseSource.bd);
  const soldOut = await f.read({ ...filters, availability: "out_of_stock" }, context);
  assert.deepEqual(soldOut.items[0].matchingVariantIds, [f.caseVariantId]);

  const beforePrice = afterStock.items[0].representative.offer;
  await saveConnectedOffer(actor, { marketId: "bd", variantId: f.caseSourceVariantId, sellerId: storeShop.id,
    amountMinor: 99900, expectedRevision: beforePrice.revision, eligible: true, publication: "ACTIVE" });
  assert.equal((await f.read(filters, context)).items[0].fromPrice?.amountMinor, 99900);
  assert.equal((await f.read(filters, us)).items[0].fromPrice?.amountMinor, f.prices.case.us);
  const changed = (await f.read(filters, context)).items[0].representative.offer;
  await saveConnectedOffer(actor, { marketId: "bd", variantId: f.caseSourceVariantId, sellerId: storeShop.id,
    amountMinor: 99900, expectedRevision: changed.revision, eligible: false, publication: "DRAFT" });
  assert.deepEqual((await f.read(filters, context)).items[0].matchingVariantIds, [f.caseVariantId]);
});

test("storefront facets retain a valid impossible pair, count alternatives beyond the page, and remove obsolete market values", async t => {
  const f = await fixture(t);
  await f.apply();
  const scope = { category: f.categories.departmentId };
  const impossible = await f.read({ ...scope, model: "Phone A", color: "Blue" }, bd, 1);
  assert.equal(impossible.total, 0);
  assert.deepEqual(impossible.browse?.removed, []);
  const selected = new URLSearchParams(impossible.browse?.selected);
  assert.equal(selected.get("color"), "blue");
  assert.ok(selected.has("model"));
  const colors = impossible.browse?.facets.find(facet => facet.id === "color");
  assert.deepEqual(colors?.values.map(({ label, count }) => [label, count]), [["Black", 1], ["Blue", 0]]);

  const second = await f.read({ ...scope, limit: "1", sort: "price-low" }, bd, 2);
  assert.equal(second.total, 2);
  assert.equal(second.browse?.page, 2);
  assert.equal(second.browse.pageCount, 2);
  assert.equal(second.items[0].id, f.caseProductId);
  assert.deepEqual(second.browse.facets.find(facet => facet.id === "brand")?.values.map(value => value.count), [2]);
  assert.deepEqual(second.browse.facets.find(facet => facet.id === "option:design")?.values.map(value => value.label), ["Floral", "Plain"]);

  await db.marketOffer.update({ where: { variantId_marketId: { variantId: f.caseSourceVariantId, marketId: "us" } },
    data: { publication: "DRAFT" } });
  const american = await f.read({ ...scope, color: "Blue" }, us, 1);
  assert.deepEqual(american.browse?.removed, ["Colour"]);
  assert.equal(american.total, 2);
  assert.equal(american.items[0].representative.offer.currency, "USD");
  assert.equal(american.items[0].representative.offer.amountMinor, f.prices.case.us);
});
