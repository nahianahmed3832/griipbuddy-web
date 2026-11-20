import assert from "node:assert/strict";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { markets } from "../../src/config/markets.ts";
import { evaluateCart, purchasedCartItem } from "../../src/lib/cart/model.ts";
import { resolveCartCatalog } from "../../src/lib/cart/resolve.ts";
import { nativeSourceSystem } from "../../src/lib/catalog-migration/contracts.ts";
import { applyCatalogMigration, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { createCatalogMigrationFixture } from "./catalog-migration-fixture.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("cart reprices the same physical variant and seller across markets while retaining purchase provenance", async () => {
  const fixture = await createCatalogMigrationFixture(db);
  const { caseVariantId, caseSourceVariantId } = fixture;
  const runs: string[] = [];
  const method = `ground-${fixture.key}`;
  const policy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" } });
  const keys = ["GRIIP_MARKET_CONFIGURATION", "GRIIP_CATALOG_MIGRATION_ISOLATED"] as const;
  const previous = keys.map(key => [key, process.env[key]] as const);
  process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ us: {
    delivery: { coverage: "checkout-policy" },
    pricing: { priceList: "us-retail", taxTreatment: "MERCHANDISE_RATE", rounding: "minor-half-up" },
    payments: [{ method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true }],
  } });
  try {
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
      enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 0, taxLabel: "Fixture tax",
    } });
    await db.deliveryZone.create({ data: { marketId: "us", district: "wa", districtLabel: "Washington", method,
      label: "Fixture ground", chargeMinor: 0 } });
    const legacy = await resolveCartCatalog([{ variantId: caseVariantId }], markets.bd);
    assert.equal(legacy[0]?.offer?.id, undefined);
    assert.equal(legacy[0]?.offer?.amountMinor, fixture.prices.case.bd);
    const plan = await dryRunCatalogMigration(fixture.manifest);
    runs.push(plan.digest);
    assert.equal((await applyCatalogMigration(plan)).status, "COMPLETED");
    const firstPartyBD = await resolveCartCatalog([{ variantId: caseVariantId }, { variantId: caseSourceVariantId }], markets.bd);
    const bdOffer = firstPartyBD[0]?.offer?.id;
    const otherOffer = firstPartyBD[1]?.offer?.id;
    assert.ok(bdOffer && otherOffer);
    assert.equal(firstPartyBD[0]?.offer?.stock, fixture.stock.case);

    const saved = { variantId: caseVariantId, offerId: bdOffer, quantity: 1 };
    const target = await resolveCartCatalog([saved], markets.us);
    const usOffer = target[0]?.offer?.id;
    assert.ok(usOffer && usOffer !== bdOffer);
    assert.equal(target[0]?.offer?.currency, "USD");
    assert.equal(target[0]?.offer?.amountMinor, fixture.prices.case.us);
    assert.equal(target[0]?.offer?.stock, fixture.stock.case);
    assert.equal(target[0]?.image.src, "/catalog/headphones-black.webp");
    assert.deepEqual(target[0]?.selectedOptions?.map(option => option.value).sort(), ["Black", "Phone A", "Plain"]);
    const revalidated = evaluateCart([saved], target, markets.us);
    assert.equal(revalidated.lines[0].status, "available");
    assert.deepEqual(revalidated.checkoutItems, [{ ...saved, offerId: usOffer, cartOfferId: bdOffer }]);
    assert.deepEqual(purchasedCartItem(revalidated.checkoutItems[0]), saved);

    const [forged] = await resolveCartCatalog([{ variantId: caseVariantId, offerId: otherOffer }], markets.us);
    assert.equal(forged.variantId, caseVariantId);
    assert.equal(forged.offer, null);
    assert.equal(forged.offerIssue, "changed");
    const aliasId = `v-${fixture.key}-verified-alias`;
    await db.catalogMigrationMapping.create({ data: {
      entity: "variant", runId: plan.digest, sourceSystem: nativeSourceSystem, sourceId: aliasId, targetId: caseVariantId,
    } });
    const alias = { variantId: aliasId, quantity: 1 };
    const mapped = evaluateCart([alias], await resolveCartCatalog([alias], markets.us), markets.us);
    assert.deepEqual(mapped.checkoutItems, [{ variantId: caseVariantId, cartVariantId: aliasId, offerId: usOffer, quantity: 1 }]);
    assert.deepEqual(purchasedCartItem(mapped.checkoutItems[0]), alias);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fixture.cleanup(runs);
    await db.deliveryZone.deleteMany({ where: { method } });
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
      enabled: policy.enabled, codEnabled: policy.codEnabled, taxTreatment: policy.taxTreatment,
      taxBasisPoints: policy.taxBasisPoints, taxLabel: policy.taxLabel,
    } });
  }
});
