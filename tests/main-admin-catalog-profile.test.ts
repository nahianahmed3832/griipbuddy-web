import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const config = new URL("../src/lib/catalog/main-admin-config.ts", import.meta.url).href;
const media = new URL("../src/lib/staff/catalog-media-upload.ts", import.meta.url).href;

test("the isolated development rollout does not reopen legacy authoring if the bridge settings are lost", () => {
  // The base path is initialized on import. A clean environment also prevents inherited bridge or provider settings.
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mainAdminCatalogConfig, mainAdminCatalogRequested, mainAdminHomepageRequested, requireLegacyCatalogBrowser } from ${JSON.stringify(config)};
    import { productMediaUploadAvailable, requireMainAdminMediaStorage } from ${JSON.stringify(media)};
    assert.equal(mainAdminCatalogConfig(), null);
    assert.equal(mainAdminCatalogRequested(), true);
    assert.equal(mainAdminHomepageRequested(), false);
    process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED = "1";
    assert.equal(mainAdminHomepageRequested(), true);
    assert.equal(mainAdminCatalogConfig(true), null);
    assert.equal(productMediaUploadAvailable(), true);
    assert.throws(requireLegacyCatalogBrowser, /main GriipBuddy admin/);

    process.env.GRIIP_DEVELOPMENT_ACCEPTANCE = "0";
    assert.equal(mainAdminCatalogRequested(), false);
    assert.equal(mainAdminHomepageRequested(), false);
    assert.equal(productMediaUploadAvailable(), false);
    assert.doesNotThrow(requireLegacyCatalogBrowser);

    process.env.COMMERCE_MODE = "production";
    process.env.GRIIP_MAIN_ADMIN_CATALOG_ORIGIN = "https://devadmin.griipbuddy.com";
    assert.equal(mainAdminCatalogRequested(), false);
    assert.equal(mainAdminHomepageRequested(), false);
    assert.equal(mainAdminCatalogConfig(true), null);
    assert.equal(productMediaUploadAvailable(), false);
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
