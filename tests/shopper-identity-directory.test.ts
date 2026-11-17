import assert from "node:assert/strict";
import { test } from "node:test";
import { storefrontPath } from "../src/config/storefront-path.ts";
import { accountReturnPath, chooseStorefrontHref, registeredStorefrontHref, shopperIdentityDirectory } from "../src/lib/marketplace/identity-directory.ts";
import { hybridDemoMode } from "../src/lib/release-config.ts";

const order = "/orders/00000000-abcd-1234-abcd-000000000000";

test("handoff return paths keep only registered account routes", () => {
  assert.equal(accountReturnPath(`/bd${order}?token=private#secret`), order);
  assert.equal(accountReturnPath(storefrontPath(`/bd${order}`)), order);
  assert.equal(accountReturnPath("/bd/account/addresses"), "/account/addresses");
  for (const path of ["//example.invalid/account", "https://example.invalid/account", "/account/../staff", "/orders/recover/secret", "/%2fexample.invalid", "/api/shopper-auth/get-session"])
    assert.equal(accountReturnPath(path), "/account");
});

test("only configured exact origins participate in a storefront session handoff", t => {
  const previous = { ...process.env };
  t.after(() => {
    for (const key of ["COMMERCE_MODE", "BETTER_AUTH_URL", "SHOPPER_IDENTITY_ORIGIN", "SHOPPER_BD_ORIGIN", "SHOPPER_US_ORIGIN",
      "DATABASE_URL", "GRIIP_MARKETPLACE_PREVIEW", "GRIIP_HYBRID_STOREFRONT"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const bd = "http://127.0.0.1:3220";
  const us = "http://localhost:3221";
  Object.assign(process.env, { COMMERCE_MODE: "local", BETTER_AUTH_URL: bd, SHOPPER_IDENTITY_ORIGIN: bd, SHOPPER_BD_ORIGIN: bd, SHOPPER_US_ORIGIN: us });
  assert.deepEqual(shopperIdentityDirectory(), { issuer: bd, current: bd, localMarket: "bd", stores: { bd, us } });
  assert.equal(registeredStorefrontHref(order, "us"), `${us}${storefrontPath(order)}?market=us`);
  assert.match(chooseStorefrontHref("us", "//example.invalid"), /return=%2Faccount$/);
  for (const invalid of ["http://localhost:3221/path", "http://someone@localhost:3221", "http://example.invalid", bd]) {
    process.env.SHOPPER_US_ORIGIN = invalid;
    assert.equal(shopperIdentityDirectory(), null);
  }
  process.env.SHOPPER_US_ORIGIN = us;
  process.env.COMMERCE_MODE = "staging";
  assert.equal(shopperIdentityDirectory(), null);

  const issuer = "https://identity.example.invalid";
  Object.assign(process.env, { SHOPPER_IDENTITY_ORIGIN: issuer, SHOPPER_BD_ORIGIN: "https://bd.example.invalid", SHOPPER_US_ORIGIN: "https://us.example.invalid",
    GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1", BETTER_AUTH_URL: issuer,
    DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db:5432/griipbuddy_hybrid_demo" });
  assert.equal(hybridDemoMode(), true);
  process.env.BETTER_AUTH_URL = "https://other.example.invalid";
  assert.equal(hybridDemoMode(), false);
  process.env.BETTER_AUTH_URL = issuer;
  process.env.DATABASE_URL = "postgresql://griipbuddy_demo:fixture@db:5432/other";
  assert.equal(hybridDemoMode(), false);
});
