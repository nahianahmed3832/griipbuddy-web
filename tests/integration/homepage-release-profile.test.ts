import assert from "node:assert/strict";
import { test } from "node:test";

test("the protected Homepage bridge preserves the independent catalog writer switch", async t => {
  const settings = {
    COMMERCE_MODE: "staging", GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_DEVELOPMENT_ACCEPTANCE: "1",
    GRIIP_MARKET_REVIEW_FIXTURES: "0", GRIIP_HOSTINGER_PILOT: "0", GRIIP_HYBRID_STOREFRONT: "0",
    DATABASE_URL: "postgresql://griipbuddy_marketplace:fixture@db:5432/griipbuddy_marketplace_dev",
    BETTER_AUTH_URL: "https://dev.griipbuddy.com", NEXT_PUBLIC_STOREFRONT_BASE_PATH: "/marketplace",
    GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED: "1", GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN: "https://devadmin.griipbuddy.com",
    GRIIP_MAIN_ADMIN_HOMEPAGE_SECRET: "homepage-fixture-".repeat(4),
    GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS: JSON.stringify({ ["6".repeat(24)]: "fixture-native-owner" }),
    GRIIP_MAIN_ADMIN_CATALOG_ORIGIN: "", GRIIP_MAIN_ADMIN_CATALOG_SECRET: "", GRIIP_MAIN_ADMIN_CATALOG_ACTORS: "",
  };
  for (const [name, value] of Object.entries(settings)) {
    const previous = process.env[name];
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    process.env[name] = value;
  }
  const { mainAdminCatalogConfig, mainAdminHomepageRequested, requireLegacyCatalogBrowser } = await import("../../src/lib/catalog/main-admin-config.ts");
  assert.equal(mainAdminHomepageRequested(), true);
  assert.equal(mainAdminCatalogConfig(true)?.actors.get("6".repeat(24)), "fixture-native-owner");
  assert.equal(mainAdminCatalogConfig(), null);
  assert.doesNotThrow(requireLegacyCatalogBrowser);

  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED = "0";
  assert.equal(mainAdminCatalogConfig(true), null);
  assert.doesNotThrow(requireLegacyCatalogBrowser);
});
