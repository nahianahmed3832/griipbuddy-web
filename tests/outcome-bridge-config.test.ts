import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_STOREFRONT_BASE_PATH = "/marketplace";
const { configuredBridge } = await import("../src/lib/measurement/bridge-contract.ts");

const development = {
  COMMERCE_MODE: "staging",
  GRIIP_MARKETPLACE_PREVIEW: "1",
  GRIIP_DEVELOPMENT_ACCEPTANCE: "1",
  BETTER_AUTH_URL: "https://dev.griipbuddy.com",
  DATABASE_URL: "postgresql://griipbuddy_marketplace:fixture-only@db:5432/griipbuddy_marketplace_dev",
  GRIIP_OUTCOME_BRIDGE_ENABLED: "1",
  GRIIP_OUTCOME_BRIDGE_AUTHORITY: "legacy-checkout",
  GRIIP_OUTCOME_BRIDGE_MARKET: "bd",
  GRIIP_OUTCOME_BRIDGE_SECRET: "bridge-test-only-noncredential-fixture",
  GRIIP_OUTCOME_BRIDGE_USE_LEGACY_CHECKOUT: "0",
  GRIIP_MARKET_CONFIGURATION: "",
  GRIIP_MARKET_REVIEW_FIXTURES: "0",
  GRIIP_HYBRID_STOREFRONT: "0",
  GRIIP_HOSTINGER_PILOT: "0",
};

test("the authenticated importer admits only opted-in fixture development with shared checkout disabled", () => {
  Object.assign(process.env, development);
  const bridge = configuredBridge();
  assert.equal(bridge?.scope, "development-report");
  assert.equal(bridge?.marketId, "bd");
  assert.equal(bridge?.currency, "BDT");
  for (const overrides of [
    { GRIIP_OUTCOME_BRIDGE_ENABLED: "0" },
    { GRIIP_OUTCOME_BRIDGE_USE_LEGACY_CHECKOUT: "1" },
    { GRIIP_DEVELOPMENT_ACCEPTANCE: "0" },
    { GRIIP_OUTCOME_BRIDGE_SECRET: "" },
    { GRIIP_OUTCOME_BRIDGE_MARKET: "us" },
    { BETTER_AUTH_URL: "https://other.example.test" },
    { DATABASE_URL: "postgresql://griipbuddy_marketplace:fixture-only@db:5432/griipbuddy_other_dev" },
    { COMMERCE_MODE: "production" },
  ]) {
    Object.assign(process.env, development, overrides);
    assert.equal(configuredBridge(), null);
  }
});
