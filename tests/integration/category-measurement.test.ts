import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { applyCatalogMigration, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { browserMeasurementSchema } from "../../src/lib/measurement/schema.ts";
import { recordMeasurement } from "../../src/lib/measurement/server.ts";
import { createCatalogMigrationFixture } from "./catalog-migration-fixture.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("consented category observations bind exact variants to market-visible category membership", async t => {
  const f = await createCatalogMigrationFixture(db);
  const previousFlag = process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
  const journeyId = randomUUID();
  const runIds: string[] = [];
  t.after(async () => {
    try {
      await db.measurementJourney.deleteMany({ where: { id: journeyId } });
      await f.cleanup(runIds);
    } finally {
      if (previousFlag === undefined) delete process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
      else process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = previousFlag;
    }
  });
  process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
  const plan = await dryRunCatalogMigration(f.manifest);
  runIds.push(plan.digest);
  await applyCatalogMigration(plan);
  // A published USD offer may participate in browse while purchase is disabled.
  await db.marketOffer.update({ where: { variantId_marketId: { variantId: f.caseSourceVariantId, marketId: "us" } }, data: {
    eligible: false,
  } });

  const sessionId = randomUUID();
  function event(fields: object) {
    return browserMeasurementSchema.parse({
      version: 1, nonce: randomUUID(), sessionId, at: new Date().toISOString(), marketId: "us",
      categoryId: f.categories.travelLeafId, ...fields,
    });
  }
  const category = event({ action: "CATEGORY_IMPRESSION", placement: "category-listing", resultCount: 1 });
  assert.equal(await recordMeasurement(journeyId, "us", category), false);
  await db.measurementJourney.create({ data: { id: journeyId, test: true, expiresAt: new Date(Date.now() + 60_000) } });
  assert.equal(await recordMeasurement(journeyId, "us", category), true);
  assert.equal(await recordMeasurement(journeyId, "us", category), true);
  assert.equal(await recordMeasurement(journeyId, "us", event({
    action: "CATEGORY_CLICK", placement: "category-navigation", categoryId: f.categories.departmentId, position: 1,
  })), true);
  const filter = event({ action: "CATEGORY_FILTER", placement: "category-listing", resultCount: 0,
    categoryFilters: { fields: ["model", "color"], sort: "price-low" } });
  assert.equal(await recordMeasurement(journeyId, "us", filter), true);
  const card = { action: "PRODUCT_CLICK", placement: "category-grid", position: 1, productId: f.caseProductId,
    variantId: f.caseSourceVariantId, displayedPriceMinor: f.prices.caseSource.us, currency: "USD" };
  assert.equal(await recordMeasurement(journeyId, "us", event(card)), true);
  assert.equal(await recordMeasurement(journeyId, "us", event({ ...card, variantId: undefined })), true);
  assert.equal(await recordMeasurement(journeyId, "us", event({ ...card, variantId: f.accessoryVariantId })), false);
  assert.equal(await recordMeasurement(journeyId, "us", event({ ...card, categoryId: "unknown-category" })), false);
  await db.marketOffer.update({ where: { variantId_marketId: { variantId: f.caseSourceVariantId, marketId: "us" } }, data: {
    publication: "DRAFT",
  } });
  assert.equal(await recordMeasurement(journeyId, "us", event(card)), false);

  const recorded = await db.measurementEvent.findMany({ where: { journeyId } });
  assert.equal(recorded.length, 5);
  assert.deepEqual(recorded.find(row => row.kind === "CATEGORY_FILTER")?.details, {
    categoryId: f.categories.travelLeafId, resultCount: 0, filterFields: ["model", "color"], sort: "price-low",
  });
  const measuredCard = recorded.find(row => row.variantId === f.caseSourceVariantId)!;
  assert.equal(measuredCard.productId, f.caseProductId);
  assert.deepEqual(measuredCard.details, { categoryId: f.categories.travelLeafId });
  assert.equal(measuredCard.marketId, "us");
  assert.equal(measuredCard.accountKey, null);
});
