import assert from "node:assert/strict";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { applyCatalogMigration, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import { getConnectedProduct, getExactConnectedVariant, productSelection } from "../../src/lib/catalog/connected-product.ts";
import { catalogDelivery, type CatalogReadContext } from "../../src/lib/catalog/connected-public.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { recordStockMovement } from "../../src/lib/commerce/physical-inventory.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { createCatalogMigrationFixture } from "./catalog-migration-fixture.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());
const now = new Date("2026-11-19T00:00:00Z");
const bd = { marketId: "bd", locale: "en-BD" } satisfies CatalogReadContext;
const us = { marketId: "us", locale: "en-US" } satisfies CatalogReadContext;

test("exact detail reads both native legacy and migrated records and never substitutes a variant", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  const runs: string[] = [];
  const isolated = process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
  process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
  try {
    const legacy = await getConnectedProduct(fixture.caseSlug, bd, fixture.caseVariantId, db, now);
    assert.equal(legacy?.product.id, fixture.caseProductId);
    assert.equal(legacy?.selection.status, "matched");
    assert.equal(legacy?.variants[0].offer.id, null);
    assert.equal(legacy?.variants[0].availability, "browse_only");
    assert.ok(await catalog.getProduct(fixture.caseSlug, "bd"));
    const plan = await dryRunCatalogMigration(fixture.manifest);
    runs.push(plan.digest);
    assert.equal((await applyCatalogMigration(plan)).status, "COMPLETED");

    for (const predecessor of [fixture.caseSourceSlug, fixture.caseSourceProductId]) {
      const connected = await getConnectedProduct(predecessor, us, fixture.caseSourceVariantId, db, now);
      assert.equal(connected?.product.id, fixture.caseProductId);
      assert.equal(connected?.product.slug, fixture.caseSlug);
      assert.equal(connected?.product.primaryCategoryId, fixture.categories.casesLeafId);
      assert.deepEqual(connected?.product.secondaryCategoryIds, [fixture.categories.travelLeafId]);
      assert.deepEqual(connected?.primaryBreadcrumb.map(entry => entry.id),
        [fixture.categories.departmentId, fixture.categories.casesCategoryId, fixture.categories.casesLeafId]);
      assert.deepEqual(connected?.selection,
        { requestedVariantId: fixture.caseSourceVariantId, status: "matched", variantId: fixture.caseSourceVariantId });
      const variant = connected?.variants.find(row => row.id === fixture.caseSourceVariantId);
      assert.ok(variant?.offer.id);
      assert.equal(variant.offer.currency, "USD");
      assert.equal(variant.offer.amountMinor, fixture.prices.caseSource.us - 200);
      assert.equal(variant.offer.regularMinor, fixture.prices.caseSource.us);
      assert.equal(variant.image?.src, "/catalog/headphones-taupe.webp");
      assert.deepEqual(variant.options.map(option => option.valueLabel).sort(), ["Blue", "Floral", "Phone B"]);
      assert.equal(connected?.options.length, 3);
      assert.equal(connected?.defaultVariantId, fixture.caseVariantId);
      assert.equal("warehouseId" in variant.offer, false);
      assert.equal("stock" in variant.offer, false);
    }

    const wrong = await getConnectedProduct(fixture.caseProductId, bd, fixture.accessoryVariantId, db, now);
    assert.deepEqual(wrong?.selection, { status: "unavailable", requestedVariantId: fixture.accessoryVariantId, variantId: null });
    assert.equal(await getExactConnectedVariant(fixture.caseSlug, fixture.accessoryVariantId, bd, db, now), null);
    assert.equal(await getExactConnectedVariant(fixture.caseSlug, "v-unknown-variant", bd, db, now), null);
    const stand = await getExactConnectedVariant(fixture.accessorySlug, fixture.accessoryVariantId, bd, db, now);
    assert.deepEqual(stand?.variant.compatibility.map(model => model.name), ["Phone A", "Phone B"]);
    assert.deepEqual(stand?.variant.options, []);

    await db.productTranslation.create({ data: { productId: fixture.caseProductId, locale: "bn",
      name: "অনুবাদ", description: "স্থানীয় পণ্যের বিবরণ" } });
    const localized = await getConnectedProduct(fixture.caseProductId, { ...bd, locale: "bn-BD" }, undefined, db, now);
    assert.equal(localized?.product.name, "অনুবাদ");
    assert.notEqual((await getConnectedProduct(fixture.caseProductId, bd, undefined, db, now))?.product.name, "অনুবাদ");
  } finally {
    if (isolated === undefined) delete process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
    else process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = isolated;
    await fixture.cleanup(runs);
  }
});

test("availability uses live delivery and offer policies and reflects audited stock changes", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  const runs: string[] = [];
  const changes = ["GRIIP_MARKET_CONFIGURATION", "GRIIP_CATALOG_MIGRATION_ISOLATED"] as const;
  const previous = changes.map(key => [key, process.env[key]] as const);
  const ownerId = `${fixture.key}-owner`;
  const marketPolicies = await db.checkoutPolicy.findMany();
  const method = `ground-${fixture.key}`;
  const context = {
    ...us, delivery: { destination: { country: "US", district: "wa", postalCode: "98101", method }, paymentMethod: "COD", quantity: 1 },
  } satisfies CatalogReadContext;
  process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ us: {
    delivery: { coverage: "checkout-policy" },
    pricing: { priceList: "us-retail", taxTreatment: "MERCHANDISE_RATE", rounding: "minor-half-up" },
    payments: [{ method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true }],
  } });
  try {
    await db.user.create({ data: { id: ownerId, name: "Stage 6 owner", email: `${ownerId}@example.invalid`,
      staff: { create: { role: "OWNER" } } } });
    await db.checkoutPolicy.updateMany({ where: { marketId: "us" }, data: {
      enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 0, taxLabel: "Fixture tax",
    } });
    await db.deliveryZone.create({ data: { marketId: "us", district: "wa", districtLabel: "Washington", method,
      label: "Fixture ground", chargeMinor: 0 } });
    const plan = await dryRunCatalogMigration(fixture.manifest);
    runs.push(plan.digest);
    await applyCatalogMigration(plan);
    const exact = (scope: CatalogReadContext = context) =>
      getExactConnectedVariant(fixture.caseProductId, fixture.caseVariantId, scope, db, now);
    assert.equal((await exact())?.variant.availability, "available");
    assert.equal((await exact())?.variant.quantityLimit, fixture.stock.case);
    assert.equal((await exact(us))?.variant.availability, "browse_only");
    assert.equal((await exact(us))?.variant.quantityLimit, undefined);
    const otherDestination = { ...context, delivery: { ...context.delivery,
      destination: { ...context.delivery.destination, district: "or", postalCode: "97201" } } };
    assert.equal((await exact(otherDestination))?.variant.availability, "delivery_unavailable");
    assert.equal((await exact({ ...context, delivery: { ...context.delivery, quantity: fixture.stock.case + 1 } }))?.variant.availability,
      "out_of_stock");

    const pool = await db.inventoryPool.findFirstOrThrow({ where: { variantId: fixture.caseVariantId } });
    const actor = { kind: "staff", id: ownerId } as const;
    await recordStockMovement(actor, { poolId: pool.id, kind: "ADJUSTMENT", quantity: -fixture.stock.case,
      reason: "Stage 6 fixture stock change", reference: "stage6", idempotencyKey: fixture.key });
    assert.equal((await exact())?.variant.availability, "out_of_stock");
    assert.equal((await exact())?.variant.quantityLimit, 0);

    const original = (await exact())!.variant.offer;
    const changed = await saveConnectedOffer(actor, { marketId: "us", variantId: fixture.caseVariantId, sellerId: storeShop.id,
      expectedRevision: original.revision, amountMinor: original.amountMinor + 100, eligible: false, publication: "DRAFT" });
    assert.equal(await exact(), null);
    const parent = await getConnectedProduct(fixture.caseProductId, context, fixture.caseVariantId, db, now);
    assert.equal(parent?.selection.status, "unavailable");
    assert.equal(parent?.selection.variantId, null);
    assert.equal(parent?.variants.length, 1);
    await saveConnectedOffer(actor, { marketId: "us", variantId: fixture.caseVariantId, sellerId: storeShop.id,
      expectedRevision: changed.revision, amountMinor: original.amountMinor + 100, eligible: false, publication: "ACTIVE" });
    assert.equal((await exact())?.variant.availability, "browse_only");
    assert.equal((await exact())?.variant.offer.amountMinor, original.amountMinor + 100);
    assert.equal((await exact(bd))?.variant.offer.amountMinor, fixture.prices.case.bd);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.auditEvent.deleteMany({ where: { actorId: ownerId } });
    await fixture.cleanup(runs);
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.deliveryZone.deleteMany({ where: { method } });
    for (const policy of marketPolicies.filter(row => row.marketId === "us")) {
      await db.checkoutPolicy.update({ where: { marketId: policy.marketId }, data: {
        enabled: policy.enabled, codEnabled: policy.codEnabled, taxTreatment: policy.taxTreatment,
        taxBasisPoints: policy.taxBasisPoints, taxLabel: policy.taxLabel,
      } });
    }
  }
});

test("catalog context rejects duplicate or incomplete delivery and selection parameters", () => {
  assert.throws(() => catalogDelivery(new URLSearchParams("quantity=2")), { code: "invalid_destination" });
  assert.throws(() => catalogDelivery(new URLSearchParams("country=US&country=BD")), { code: "invalid_context" });
  assert.throws(() => productSelection(new URLSearchParams("variant=one&variant=two")), { code: "invalid_variant" });
  const params = new URLSearchParams("country=us&district=WA&method=Ground&paymentMethod=COD&variant=v-real-id");
  assert.deepEqual(catalogDelivery(params), { destination: { country: "US", district: "wa", method: "ground", postalCode: undefined },
    paymentMethod: "COD", quantity: 1 });
  assert.equal(productSelection(params), "v-real-id");
});
