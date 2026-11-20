import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import "../../scripts/load-env.ts";
import {
  getMigratedProductBrowse, resolveCatalogMigrationReference, resolveMigratedProductLanding, resolveMigratedProductSlug,
} from "../../src/lib/catalog-migration/compatibility.ts";
import { applyCatalogMigration, catalogMigrationTarget, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import { migrationDigest, migrationVersion, nativeSourceSystem } from "../../src/lib/catalog-migration/contracts.ts";
import { guestOrder } from "../../src/lib/commerce/orders.ts";
import { recordStockMovement } from "../../src/lib/commerce/physical-inventory.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { staffOrderCase } from "../../src/lib/marketplace/cases.ts";
import { staffOrder } from "../../src/lib/staff/operations.ts";
import { createCatalogMigrationFixture } from "./catalog-migration-fixture.ts";
import { createActiveMigrationHold, createMigrationHistoryFixture } from "./catalog-migration-history-fixture.ts";

process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
catalogMigrationTarget();
const db = getDb();
after(() => db.$disconnect());
const exec = promisify(execFile);

function cli(...args: string[]) {
  return exec(process.execPath, ["--import", "tsx", "scripts/catalog-migration.ts", ...args]);
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, "utf8")) as unknown;

async function businessState(productIds: string[], variantIds: string[]) {
  return {
    products: await db.product.findMany({ where: { id: { in: productIds } }, orderBy: { id: "asc" } }),
    variants: await db.variant.findMany({ where: { id: { in: variantIds } }, orderBy: { id: "asc" } }),
    balances: await db.inventory.findMany({ where: { variantId: { in: variantIds } }, orderBy: { variantId: "asc" } }),
    locationBalances: await db.locationInventory.findMany({ where: { variantId: { in: variantIds } }, orderBy: { variantId: "asc" } }),
    offers: await db.marketOffer.findMany({ where: { variantId: { in: variantIds } }, orderBy: [{ variantId: "asc" }, { marketId: "asc" }] }),
    pools: await db.inventoryPool.findMany({ where: { variantId: { in: variantIds } }, orderBy: { id: "asc" } }),
    movements: await db.inventoryMovement.findMany({ where: { pool: { variantId: { in: variantIds } } }, orderBy: { id: "asc" } }),
    mappings: await db.catalogMigrationMapping.findMany({ orderBy: [{ entity: "asc" }, { sourceId: "asc" }] }),
    checkpoints: await db.catalogMigrationCheckpoint.findMany({ orderBy: [{ runId: "asc" }, { batchKey: "asc" }] }),
  };
}

test("migration dry run is read-only, interrupted apply resumes, and replay preserves exact commerce and history", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  const working = await mkdtemp(join(tmpdir(), "griip-catalog-review-"));
  const runIds: string[] = [];
  const ownerId = `${fixture.key}-operator`;
  const history = await createMigrationHistoryFixture(db, {
    key: fixture.key, productId: fixture.caseSourceProductId, variantId: fixture.caseSourceVariantId,
    sku: fixture.caseSourceSku, slug: fixture.caseSourceSlug,
  });
  try {
    const products = [fixture.caseProductId, fixture.caseSourceProductId, fixture.accessoryProductId];
    const variants = [fixture.caseVariantId, fixture.caseSourceVariantId, fixture.accessoryVariantId];
    const before = await businessState(products, variants);
    const purchasedBefore = await db.orderItem.findUniqueOrThrow({ where: { id: history.lineId } });
    await db.user.create({ data: { id: ownerId, name: "Synthetic migration operator", email: `${ownerId}@example.invalid`,
      staff: { create: { role: "OWNER" } } } });
    const readHistory = async () => ({
      shopper: await guestOrder(history.orderId, null, history.shopperId),
      packing: await staffOrder(ownerId, history.orderId),
      returns: await staffOrderCase(ownerId, history.returnId),
    });
    const historyBefore = await readHistory();
    assert.equal(historyBefore.shopper?.items[0].variantName, history.variantName);
    assert.equal(historyBefore.shopper?.items[0].unitPriceMinor, history.unitPriceMinor);
    assert.equal(historyBefore.packing?.parcels[0].id, history.parcelId);
    assert.equal(historyBefore.returns?.returnLines[0].orderItem.productName, history.productName);
    const manifestPath = join(working, "manifest.json");
    const review = join(working, "review");
    const paused = join(working, "paused");
    const completed = join(working, "applied");
    const replay = join(working, "replayed");
    await writeFile(manifestPath, JSON.stringify(fixture.manifest), { mode: 0o600 });
    await cli("dry-run", "--manifest", manifestPath, "--report", review);
    const plan = await dryRunCatalogMigration(fixture.manifest);
    runIds.push(plan.digest);
    assert.deepEqual(await readJson(`${review}.json`), plan);
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.batches.length, 3);
    assert.equal(plan.batches[1].sourceProducts, 2);
    assert.equal(plan.batches[1].targetProducts, 1);
    assert.deepEqual(plan.batches[1].historyCounts, { orders: 1, orderItems: 1, parcelItems: 1, returnLines: 1,
      orderCases: 1, payments: 1, providerSessions: 1, favorites: 1, listItems: 1, variantWatches: 1, carts: 1 });
    assert.deepEqual(await businessState(products, variants), before);
    assert.equal(await db.catalogMigrationRun.count({ where: { id: plan.digest } }), 0);

    await cli("apply", "--plan", `${review}.json`, "--report", paused, "--max-batches", "2");
    assert.match(await readFile(`${paused}.md`, "utf8"), /\*\*PAUSED\*\*/);
    assert.equal(await db.catalogMigrationCheckpoint.count({ where: { runId: plan.digest } }), 2);
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: fixture.accessoryProductId } })).foundation, false);
    await cli("apply", "--plan", `${review}.json`, "--report", completed);
    assert.match(await readFile(`${completed}.md`, "utf8"), /\*\*COMPLETED\*\*/);
    assert.match(await readFile(`${completed}.md`, "utf8"), /verified 2 existing checkpoints/);
    assert.equal(await db.catalogMigrationCheckpoint.count({ where: { runId: plan.digest } }), 3);
    const applied = await businessState(products, variants);

    const migratedVariant = applied.variants.find(row => row.id === fixture.caseSourceVariantId);
    assert.equal(migratedVariant?.productId, fixture.caseProductId);
    assert.equal(migratedVariant?.sku, fixture.caseSourceSku);
    assert.equal(applied.products.find(row => row.id === fixture.caseProductId)?.departmentId, fixture.categories.casesLeafId);
    assert.ok(await db.productSecondaryCategory.findUnique({ where: { productId_departmentId: {
      productId: fixture.caseProductId, departmentId: fixture.categories.travelLeafId,
    } } }));
    const mergedListing = applied.products.find(row => row.id === fixture.caseSourceProductId);
    assert.equal(mergedListing?.publication, "ARCHIVED");
    assert.deepEqual(await resolveMigratedProductSlug(fixture.caseSourceSlug), { id: fixture.caseProductId, slug: fixture.caseSlug });
    assert.deepEqual(await resolveMigratedProductLanding(fixture.caseSourceSlug, "us", fixture.caseSourceVariantId),
      { slug: fixture.caseSlug, variantId: fixture.caseSourceVariantId });
    assert.deepEqual(await resolveMigratedProductLanding(fixture.caseSourceSlug, "bd", fixture.accessoryVariantId),
      { slug: fixture.caseSlug, variantId: undefined });
    assert.deepEqual(await resolveCatalogMigrationReference({ sourceSystem: nativeSourceSystem, entity: "product",
      sourceId: fixture.caseSourceProductId }), { id: fixture.caseProductId, entity: "product" });
    for (const mapping of fixture.manifest.batches.flatMap(row => row.legacyReferences)) {
      assert.deepEqual(await resolveCatalogMigrationReference({ sourceSystem: mapping.sourceSystem, entity: mapping.entity,
        sourceId: mapping.sourceId }), { entity: mapping.entity, id: mapping.targetId });
    }
    const accessory = applied.products.find(row => row.id === fixture.accessoryProductId);
    assert.equal(accessory?.foundation, true);
    assert.equal(applied.variants.find(row => row.id === fixture.accessoryVariantId)?.isDefault, true);
    assert.deepEqual(applied.variants.filter(row => row.productId === fixture.accessoryProductId).map(row => row.sku), [fixture.accessorySku]);
    assert.equal(await db.variantCompatibility.count({ where: { variantId: fixture.accessoryVariantId } }), 2);
    const casePools = applied.pools.filter(row => row.variantId === fixture.caseVariantId);
    const expectedPool = fixture.manifest.batches[0].commerce.inventory.find(row => row.variantId === fixture.caseVariantId)!;
    assert.equal(casePools.length, 1);
    assert.equal(casePools[0].onHand, expectedPool.onHand);
    assert.equal(casePools[0].reserved, 0);
    assert.equal(casePools[0].locationId, fixture.locationId);
    assert.equal(applied.movements.filter(row => row.poolId === casePools[0].id).length, 1);
    assert.deepEqual(applied.balances, before.balances);
    assert.deepEqual(applied.locationBalances, before.locationBalances);
    assert.deepEqual(applied.offers.map(row => ({ ...row, offerId: null })), before.offers);
    assert.deepEqual((await db.dispatchLocationMarket.findMany({ where: { locationId: fixture.locationId },
      select: { marketId: true }, orderBy: { marketId: "asc" } })).map(row => row.marketId), ["bd", "us"]);
    for (const offer of fixture.manifest.batches[0].commerce.offers.filter(row => row.variantId === fixture.caseVariantId)) {
      const browse = await getMigratedProductBrowse(fixture.caseSlug, offer.marketId, "en");
      const current = applied.offers.find(row => row.marketId === offer.marketId && row.variantId === offer.variantId);
      assert.equal(current?.amountMinor, offer.amountMinor);
      assert.equal(current?.currency, offer.currency);
      assert.equal(browse?.variants.find(row => row.id === offer.variantId)?.priceMinor, offer.amountMinor);
      assert.ok(current?.offerId);
    }
    assert.deepEqual(await readHistory(), historyBefore);
    assert.deepEqual(await db.orderItem.findUniqueOrThrow({ where: { id: history.lineId } }), purchasedBefore);
    assert.equal(purchasedBefore.sku, fixture.caseSourceSku);

    await cli("apply", "--plan", `${review}.json`, "--report", replay);
    assert.match(await readFile(`${replay}.md`, "utf8"), /Applied 0 batches, verified 3 existing checkpoints/);
    assert.deepEqual(await businessState(products, variants), applied);

    const reportDirectory = process.env.GRIIP_MIGRATION_FIXTURE_REPORT;
    if (reportDirectory) {
      await mkdir(reportDirectory, { recursive: true });
      for (const format of ["json", "md"]) await copyFile(`${completed}.${format}`, join(reportDirectory, `catalog-migration-rehearsal.${format}`));
    }

    // Replaying an old plan after a legitimate later balance change cannot undo the new stock.
    await recordStockMovement({ kind: "staff", id: ownerId }, {
      poolId: casePools[0].id, kind: "RECEIPT", quantity: 1, idempotencyKey: "fixture-receipt-after-migration",
      reason: "Fixture receipt after migration", reference: "rehearsal-delivery",
    });
    await assert.rejects(applyCatalogMigration(plan), { code: "target-changed" });
    assert.equal((await db.inventoryPool.findUniqueOrThrow({ where: { id: casePools[0].id } })).onHand, expectedPool.onHand + 1);
  } finally {
    await history.cleanup();
    await fixture.cleanup(runIds);
    await db.user.deleteMany({ where: { id: ownerId } });
    await rm(working, { recursive: true, force: true });
  }
});

test("a conflicting stored legacy mapping cannot be overwritten", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  const priorRun = migrationDigest(fixture.key);
  try {
    await db.catalogMigrationRun.create({ data: { id: priorRun, status: "COMPLETED", version: migrationVersion, expectedBatches: 1 } });
    const stored = { sourceSystem: nativeSourceSystem, entity: "product", sourceId: fixture.caseSourceProductId };
    await db.catalogMigrationMapping.create({ data: { ...stored, targetId: fixture.accessoryProductId, runId: priorRun } });
    const plan = await dryRunCatalogMigration(fixture.manifest);
    assert.ok(plan.batches[1].issues.some(row => row.code === "conflicting-mapping"));
    await assert.rejects(applyCatalogMigration(plan), { code: "unresolved-conflicts" });
    const existing = await db.catalogMigrationMapping.findUniqueOrThrow({ where: { sourceSystem_entity_sourceId: stored } });
    assert.equal(existing.targetId, fixture.accessoryProductId);
  } finally { await fixture.cleanup([priorRun]); }
});

test("ambiguous groups and conflicting physical counts block all writes", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  try {
    const reviewed = structuredClone(fixture.manifest);
    const affected = reviewed.batches[0];
    delete affected.catalog.groupingEvidence;
    affected.commerce.inventory.find(row => row.variantId === fixture.caseVariantId)!.onHand += 1;
    affected.commerce.offers.pop();
    const plan = await dryRunCatalogMigration(reviewed);
    const codes = plan.batches[1].issues.map(issue => issue.code);
    assert.ok(codes.includes("AMBIGUOUS_PRODUCT_GROUP"));
    assert.ok(codes.includes("conflicting_stock_count"));
    assert.ok(codes.includes("missing_offer_evidence"));
    await assert.rejects(applyCatalogMigration(plan), { code: "unresolved-conflicts" });
    assert.equal(await db.catalogMigrationRun.count({ where: { id: plan.digest } }), 0);
    assert.equal(await db.inventoryPool.count({ where: { locationId: fixture.locationId } }), 0);
  } finally { await fixture.cleanup(); }
});

test("a changed source invalidates the sealed dry run before any checkpoint", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  try {
    const plan = await dryRunCatalogMigration(fixture.manifest);
    assert.deepEqual(plan.batches.flatMap(batch => batch.issues), []);
    const isolation = process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
    delete process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
    try { await assert.rejects(applyCatalogMigration(plan), { code: "isolated-profile-required" }); }
    finally { process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = isolation; }
    const editedPlan = { ...plan, target: "localhost:9999/griipbuddy_test" };
    await assert.rejects(applyCatalogMigration(editedPlan), { code: "plan-mismatch" });
    await db.inventory.update({ where: { variantId: fixture.caseVariantId }, data: { available: { increment: 1 } } });
    await assert.rejects(applyCatalogMigration(plan), { code: "source-changed" });
    assert.equal(await db.catalogMigrationRun.count({ where: { id: plan.digest } }), 0);
    assert.equal((await db.product.findUniqueOrThrow({ where: { id: fixture.caseProductId } })).foundation, false);
    assert.equal(await db.inventoryPool.count({ where: { locationId: fixture.locationId } }), 0);
  } finally { await fixture.cleanup(); }
});

test("pending provider stock is quarantined and retains its original session and balance", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  const hold = await createActiveMigrationHold(db, {
    key: fixture.key, variantId: fixture.caseVariantId, locationId: fixture.locationId,
  });
  try {
    const before = await db.prepaidCheckout.findUniqueOrThrow({ where: { attemptId: hold.attemptId } });
    const stockBefore = await db.inventory.findUniqueOrThrow({ where: { variantId: fixture.caseVariantId } });
    const plan = await dryRunCatalogMigration(fixture.manifest);
    assert.ok(plan.batches[1].issues.some(row => row.code === "open_payment"));
    assert.ok(plan.batches[1].issues.some(row => row.code === "allocation_count_mismatch"));
    await assert.rejects(applyCatalogMigration(plan), { code: "unresolved-conflicts" });
    assert.deepEqual(await db.prepaidCheckout.findUniqueOrThrow({ where: { attemptId: hold.attemptId } }), before);
    assert.deepEqual(await db.inventory.findUniqueOrThrow({ where: { variantId: fixture.caseVariantId } }), stockBefore);
    assert.equal(await db.inventoryPool.count({ where: { locationId: fixture.locationId } }), 0);
  } finally {
    await hold.cleanup();
    await fixture.cleanup();
  }
});
