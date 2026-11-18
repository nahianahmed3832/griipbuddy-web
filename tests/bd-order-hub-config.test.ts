import assert from "node:assert/strict";
import { test } from "node:test";
import { bdOrderHubConfig, legacyCursor } from "../src/lib/marketplace/bd-order-hub-bridge.ts";

test("Bangladesh order bridge is restricted to the isolated hybrid preview and its private network", t => {
  const values = {
    COMMERCE_MODE: "staging",
    GRIIP_MARKETPLACE_PREVIEW: "1",
    GRIIP_HYBRID_STOREFRONT: "1",
    BETTER_AUTH_URL: "https://dev.griipbuddy.com",
    DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db/griipbuddy_hybrid_demo",
    SHOPPER_MAIL_MODE: "preview",
    BD_ORDER_HUB_MODE: "isolated",
    BD_ORDER_HUB_BRIDGE_TOKEN: "b".repeat(64),
    BD_ORDER_HUB_BRIDGE_URL: "http://bd-order-hub-api:38100",
  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, values);
  assert.equal(bdOrderHubConfig()?.origin.origin, values.BD_ORDER_HUB_BRIDGE_URL);

  assert.equal(legacyCursor.safeParse("eyJkYXRlIjoifQ").success, true);
  assert.equal(legacyCursor.safeParse("https://example.invalid").success, false);
  for (const [key, invalid] of [
    ["COMMERCE_MODE", "production"],
    ["SHOPPER_MAIL_MODE", "smtp"],
    ["BD_ORDER_HUB_BRIDGE_TOKEN", "too-short"],
    ["BD_ORDER_HUB_BRIDGE_URL", "https://griipbuddy.com"],
    ["BD_ORDER_HUB_BRIDGE_URL", "http://bd-order-hub-api:38100/other"],
    ["BD_ORDER_HUB_BRIDGE_URL", "http://bd-order-hub-api@wrong-host"],
  ] as const) {
    process.env[key] = invalid;
    assert.equal(bdOrderHubConfig(), null, key);
    process.env[key] = values[key];
  }
});
