import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const config = new URL("../src/lib/catalog/main-admin-config.ts", import.meta.url).href;
const media = new URL("../src/lib/staff/catalog-media-upload.ts", import.meta.url).href;
const parcels = new URL("../src/lib/commerce/order-parcels.ts", import.meta.url).href;

test("the isolated development rollout retains legacy authoring only in the explicit dormant catalog profile", () => {
  // The base path is initialized on import. A clean environment also prevents inherited bridge or provider settings.
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mainAdminCatalogConfig, mainAdminCatalogDormant, mainAdminCatalogRequested, mainAdminHomepageRequested, mainAdminMarketplaceConfig, requireLegacyCatalogBrowser, scopedCatalogPilotDigest } from ${JSON.stringify(config)};
    import { productMediaUploadAvailable, requireMainAdminMediaStorage } from ${JSON.stringify(media)};
    import { orderParcelSplitsPaused } from ${JSON.stringify(parcels)};
    assert.equal(mainAdminCatalogConfig(), null);
    assert.equal(mainAdminCatalogRequested(), true);
    assert.equal(mainAdminHomepageRequested(), false);
    process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED = "1";
    assert.equal(mainAdminHomepageRequested(), true);
    assert.equal(mainAdminCatalogConfig(true), null);
    assert.equal(productMediaUploadAvailable(), true);
    assert.throws(requireLegacyCatalogBrowser, /main GriipBuddy admin/);

    process.env.GRIIP_MAIN_ADMIN_CATALOG_DORMANT = "1";
    process.env.GRIIP_MAIN_ADMIN_CATALOG_SCOPED_PILOT = "0";
    process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN = "https://devadmin.griipbuddy.com";
    process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_SECRET = "h".repeat(32);
    process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS = JSON.stringify({ ["1".repeat(24)]: "fixture-owner" });
    process.env.GRIIP_MAIN_ADMIN_MARKETPLACE_ENABLED = "1";
    process.env.GRIIP_MAIN_ADMIN_MARKETPLACE_SECRET = "m".repeat(32);
    assert.equal(mainAdminCatalogDormant(), true);
    assert.equal(mainAdminCatalogRequested(), false);
    assert.equal(mainAdminCatalogConfig(), null);
    assert.equal(mainAdminCatalogConfig(true)?.secret, "h".repeat(32));
    assert.equal(mainAdminMarketplaceConfig()?.secret, "m".repeat(32));
    assert.equal(orderParcelSplitsPaused(), true);
    assert.doesNotThrow(requireLegacyCatalogBrowser);

    process.env.GRIIP_MAIN_ADMIN_CATALOG_SECRET = "partial";
    assert.equal(mainAdminCatalogDormant(), false);
    assert.throws(requireLegacyCatalogBrowser, /main GriipBuddy admin/);
    delete process.env.GRIIP_MAIN_ADMIN_CATALOG_SECRET;
    process.env.GRIIP_MAIN_ADMIN_CATALOG_REVIEW_DIGEST = "a".repeat(64);
    assert.equal(mainAdminCatalogDormant(), false);
    assert.throws(requireLegacyCatalogBrowser, /main GriipBuddy admin/);
    delete process.env.GRIIP_MAIN_ADMIN_CATALOG_REVIEW_DIGEST;
    process.env.GRIIP_MAIN_ADMIN_CATALOG_DORMANT = "true";
    assert.equal(mainAdminCatalogDormant(), false);
    assert.throws(requireLegacyCatalogBrowser, /main GriipBuddy admin/);
    process.env.GRIIP_MAIN_ADMIN_CATALOG_DORMANT = "1";

    process.env.GRIIP_MAIN_ADMIN_CATALOG_SCOPED_PILOT = "1";
    process.env.GRIIP_MAIN_ADMIN_CATALOG_REVIEW_DIGEST = "a".repeat(64);
    assert.equal(mainAdminCatalogDormant(), false);
    assert.equal(orderParcelSplitsPaused(), true);
    assert.equal(scopedCatalogPilotDigest(), null);
    process.env.GRIIP_MAIN_ADMIN_CATALOG_ORIGIN = "https://devadmin.griipbuddy.com";
    process.env.GRIIP_MAIN_ADMIN_CATALOG_SECRET = "s".repeat(32);
    process.env.GRIIP_MAIN_ADMIN_CATALOG_ACTORS = JSON.stringify({ ["1".repeat(24)]: "fixture-owner" });
    assert.equal(scopedCatalogPilotDigest(), "a".repeat(64));
    process.env.GRIIP_MAIN_ADMIN_CATALOG_SCOPED_PILOT = "true";
    assert.equal(scopedCatalogPilotDigest(), null);
    process.env.GRIIP_MAIN_ADMIN_CATALOG_SCOPED_PILOT = "1";
    process.env.GRIIP_MAIN_ADMIN_CATALOG_REVIEW_DIGEST = "reviewed";
    assert.equal(scopedCatalogPilotDigest(), null);
    process.env.GRIIP_MAIN_ADMIN_CATALOG_REVIEW_DIGEST = "a".repeat(64);

    process.env.GRIIP_DEVELOPMENT_ACCEPTANCE = "0";
    assert.equal(mainAdminCatalogDormant(), false);
    assert.equal(mainAdminCatalogRequested(), false);
    assert.equal(mainAdminHomepageRequested(), false);
    assert.equal(productMediaUploadAvailable(), false);
    assert.equal(scopedCatalogPilotDigest(), null);
    assert.doesNotThrow(requireLegacyCatalogBrowser);

    process.env.COMMERCE_MODE = "production";
    process.env.GRIIP_MAIN_ADMIN_CATALOG_ORIGIN = "https://devadmin.griipbuddy.com";
    assert.equal(mainAdminCatalogDormant(), false);
    assert.equal(mainAdminCatalogRequested(), false);
    assert.equal(mainAdminHomepageRequested(), false);
    assert.equal(mainAdminCatalogConfig(true), null);
    assert.equal(productMediaUploadAvailable(), false);
    assert.equal(scopedCatalogPilotDigest(), null);
    await assert.rejects(requireMainAdminMediaStorage(), /isolated Marketplace catalog media store/);
  `], { encoding: "utf8", env: {
    NODE_ENV: "test",
    COMMERCE_MODE: "staging",
    DATABASE_URL: "postgresql://griipbuddy_marketplace:fixture-only@db:5432/griipbuddy_marketplace_dev",
    BETTER_AUTH_URL: "https://dev.griipbuddy.com",
    GRIIP_DEVELOPMENT_ACCEPTANCE: "1",
    GRIIP_MARKETPLACE_PREVIEW: "1",
    NEXT_PUBLIC_STOREFRONT_BASE_PATH: "/marketplace",
  } });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
