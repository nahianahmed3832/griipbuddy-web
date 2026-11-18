import assert from "node:assert/strict";
import { test } from "node:test";
import { bdOrderHubConfig, legacyCursor } from "../src/lib/marketplace/bd-order-hub-bridge.ts";
import { orderCenterEnabled } from "../src/lib/marketplace/order-center-config.ts";

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
    GRIIP_FIXTURE_MARKET: "",
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
  assert.equal(orderCenterEnabled("bd"), true);
  assert.equal(orderCenterEnabled("us"), true);
  assert.equal(orderCenterEnabled("ca"), false);
  process.env.GRIIP_FIXTURE_MARKET = "ca";
  assert.equal(orderCenterEnabled("ca"), true);

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
    if (key === "COMMERCE_MODE" || key === "SHOPPER_MAIL_MODE") {
      assert.equal(orderCenterEnabled("us"), false, key);
      assert.equal(orderCenterEnabled("ca"), false, key);
    }
    process.env[key] = values[key];
  }
  process.env.BD_ORDER_HUB_MODE = "";
  assert.equal(orderCenterEnabled("bd"), false);
  assert.equal(orderCenterEnabled("us"), true);
  process.env.BD_ORDER_HUB_MODE = values.BD_ORDER_HUB_MODE;
  process.env.BETTER_AUTH_URL = "https://shop.griipbuddy.invalid";
  assert.equal(orderCenterEnabled("us"), false);
});
