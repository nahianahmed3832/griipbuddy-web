import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { resolveMigratedProductLanding } from "../../src/lib/catalog-migration/compatibility.ts";
import { applyCatalogMigration, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import { catalogRobots, catalogSitemapPaths, hasBrowseFilters, productSeoAlternates, sitemapMarkets } from "../../src/lib/catalog/catalog-seo.ts";
import { getConnectedProduct } from "../../src/lib/catalog/connected-product.ts";
import { breadcrumbMetadata, connectedProductMetadata } from "../../src/lib/catalog/product-metadata.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { productionOrigin } from "../../src/lib/release-config.ts";
import { createCatalogMigrationFixture } from "./catalog-migration-fixture.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("localized product groups and the sitemap retain the canonical parent and live market-visible variants", async () => {
  const keys = ["COMMERCE_MODE", "STOREFRONT_POLICY_FILE", "GRIIP_MARKET_CONFIGURATION", "GRIIP_CATALOG_MIGRATION_ISOLATED"] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const fixture = await createCatalogMigrationFixture(db);
  const directory = await mkdtemp(join(tmpdir(), "griip-seo-fixture-"));
  const runs: string[] = [];

  try {
    process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
    process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ bd: { languages: ["en-BD", "bn-BD"] } });
    const plan = await dryRunCatalogMigration(fixture.manifest);
    runs.push(plan.digest);
    await applyCatalogMigration(plan);
    const id = fixture.caseProductId;
    const { caseSlug: slug, caseSourceSlug, caseVariantId, caseSourceVariantId } = fixture;
    const path = `/products/${slug}`;

    await db.productTranslation.create({ data: { productId: id, locale: "bn", name: "সুরক্ষামূলক কেস", description: "স্থানীয় বিবরণ" } });
    await db.departmentTranslation.create({ data: { departmentId: fixture.categories.casesLeafId, locale: "bn-BD",
      name: "কেস", shortName: "কেস", description: "কেসের বিভাগ", slug: `${fixture.key}-localized-cases` } });
    await db.variant.update({ where: { id: caseSourceVariantId }, data: { mpn: "QA-CASE-B", gtin: "012345678905" } });
    await db.marketOffer.update({ where: { variantId_marketId: { variantId: caseVariantId, marketId: "us" } }, data: { eligible: false } });

    const now = new Date("2026-11-19T00:00:00Z");
    const bangla = await getConnectedProduct(slug, { marketId: "bd", locale: "bn-BD" }, caseSourceVariantId, db, now);
    const usa = await getConnectedProduct(slug, { marketId: "us", locale: "en-US" }, caseSourceVariantId, db, now);
    assert.ok(bangla && usa);
    assert.equal(bangla.product.name, "সুরক্ষামূলক কেস");
    assert.deepEqual(bangla.primaryBreadcrumb.map(crumb => crumb.localizedSlug), [
      fixture.categories.departmentId, fixture.categories.casesCategoryId, `${fixture.key}-localized-cases`,
    ]);

    const pageUrl = new URL(`${path}?market=bd&lang=bn-BD&option=colour:blue&variant=${caseSourceVariantId}`, "https://store.example.invalid");
    const bdMetadata = connectedProductMetadata(bangla.product, bangla.variants, pageUrl.href);
    const bdGroup = bdMetadata.markup;
    assert.ok(bdGroup && "hasVariant" in bdGroup && bdGroup.hasVariant);
    assert.equal(bdGroup.name, "সুরক্ষামূলক কেস");
    assert.equal(bdGroup.productGroupID, id);
    assert.equal(new URL(bdGroup.url).search, "?market=bd&lang=bn-BD");
    assert.deepEqual(bdGroup.variesBy, ["https://schema.org/color"]);
    const second = bdGroup.hasVariant.find(row => new URL(row.url).searchParams.get("variant") === caseSourceVariantId);
    assert.ok(second);
    assert.equal(second.sku, (await db.variant.findUniqueOrThrow({ where: { id: caseSourceVariantId } })).sku);
    assert.equal(second.mpn, "QA-CASE-B");
    assert.equal(second.gtin, "012345678905");
    assert.match(second.image[0], /headphones-taupe.webp$/);
    assert.deepEqual(second.offers, {
      "@type": "Offer", url: second.url, price: (fixture.prices.caseSource.bd / 100).toFixed(2), priceCurrency: "BDT",
    });
    const usGroup = connectedProductMetadata(usa.product, usa.variants, `https://store.example.invalid${path}?market=us&lang=en-US`).markup;
    assert.ok(usGroup && "hasVariant" in usGroup && usGroup.hasVariant);
    const usd = usGroup.hasVariant.find(row => new URL(row.url).searchParams.get("variant") === caseSourceVariantId)?.offers;
    assert.equal(usd?.priceCurrency, "USD");
    assert.equal(usd?.price, ((fixture.prices.caseSource.us - 200) / 100).toFixed(2));
    assert.equal(usGroup.hasVariant.find(row => new URL(row.url).searchParams.get("variant") === caseVariantId)?.offers, undefined);

    const crumbs = breadcrumbMetadata(bangla.primaryBreadcrumb.map(category => ({
      label: category.name, href: `/departments/${category.localizedSlug}?market=bd&lang=bn-BD`,
    })), { label: bdGroup.name, href: bdGroup.url });
    assert.deepEqual(crumbs?.itemListElement.map(item => item.position), [1, 2, 3, 4]);
    assert.equal(new URL(crumbs!.itemListElement[2].item).pathname, `/departments/${fixture.key}-localized-cases`);
    assert.deepEqual(await resolveMigratedProductLanding(caseSourceSlug, "bd", caseSourceVariantId, db),
      { slug, variantId: caseSourceVariantId });
    assert.deepEqual(sitemapMarkets(), []);
    assert.deepEqual(catalogRobots({ id: "bd", locale: "bn-BD" }), { index: false, follow: false });

    // Use the local fixture connection to exercise the publish-only metadata policy with synthetic policy text.
    const policy = join(directory, "policies.json");
    await writeFile(policy, JSON.stringify(Object.fromEntries(["delivery", "returns", "privacy", "terms"].map(topic => [topic, ["Fixture policy"]]))));
    process.env.COMMERCE_MODE = "production";
    process.env.STOREFRONT_POLICY_FILE = policy;
    const market = { id: "bd", locale: "bn-BD" } as const;
    const parentUrl = (suffix: string) => `${productionOrigin}${path}?${suffix}`;
    assert.deepEqual(await productSeoAlternates({ id, slug }, market, db), {
      canonical: parentUrl("market=bd&lang=bn-BD"), languages: {
        "en-BD": parentUrl("market=bd&lang=en-BD"), "bn-BD": parentUrl("market=bd&lang=bn-BD"), "en-US": parentUrl("market=us&lang=en-US"),
      },
    });
    assert.deepEqual(catalogRobots(market, hasBrowseFilters({ market: "bd", design: ["Floral"], page: "2" })), { index: false, follow: true });
    assert.equal(catalogRobots(market, hasBrowseFilters({ market: "bd", lang: "bn-BD" })), undefined);
    const sitemapPaths = await catalogSitemapPaths(db, sitemapMarkets());
    assert.deepEqual(sitemapPaths.filter(entry => entry.startsWith(path)).sort(), [
      `${path}?market=bd&lang=bn-BD`, `${path}?market=bd&lang=en-BD`, `${path}?market=us&lang=en-US`,
    ]);
    assert.ok(sitemapPaths.includes(`/departments/${fixture.key}-localized-cases?market=bd&lang=bn-BD`));
    assert.ok(!sitemapPaths.some(entry => entry.includes(caseSourceSlug) || /[?&](variant|option)=/.test(entry)));

    process.env.COMMERCE_MODE = "local";
    await db.marketOffer.update({ where: { variantId_marketId: { marketId: "us", variantId: caseSourceVariantId } },
      data: { publication: "DRAFT", eligible: false } });
    const remaining = await getConnectedProduct(slug, { marketId: "us", locale: "en-US" }, caseSourceVariantId, db, now);
    assert.deepEqual(remaining?.selection, { status: "unavailable", requestedVariantId: caseSourceVariantId, variantId: null });
    const updated = connectedProductMetadata(remaining!.product, remaining!.variants, `https://store.example.invalid${path}?market=us`).markup;
    assert.equal(updated?.["@type"], "Product");
    assert.ok(!JSON.stringify(updated).includes(caseSourceVariantId));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
    await db.departmentTranslation.deleteMany({ where: { departmentId: fixture.categories.casesLeafId } });
    await fixture.cleanup(runs);
  }
});
