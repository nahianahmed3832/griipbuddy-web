import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, isStorefrontMarketId, marketDirectory, marketIds, markets } from "../src/config/markets.ts";
import { marketStoreHref, marketStoreUrl } from "../src/config/regional-path.ts";
import { fixtureMarketEnabled } from "../src/lib/release-config.ts";

test("the market registry defines unique country identities and valid locales and currencies", () => {
  const countries = new Set<string>();
  const prefixes = new Set<string>();
  for (const id of marketIds) {
    const market = markets[id];
    assert.equal(market.countryCode, id.toUpperCase());
    assert.equal(countries.has(market.countryCode), false);
    countries.add(market.countryCode);
    assert.ok(market.languages.includes(market.defaultLanguage));
    assert.equal(new Intl.Locale(market.locale).region, market.countryCode);
    new Intl.DateTimeFormat(market.locale, { timeZone: market.timeZone });
    assert.equal(new Intl.NumberFormat(market.locale, { style: "currency", currency: market.currency }).resolvedOptions().currency, market.currency);
    if (market.pathPrefix) {
      assert.equal(prefixes.has(market.pathPrefix), false);
      prefixes.add(market.pathPrefix);
    }
  }
  assert.match(formatMoney(2499, markets.ca), /CAD\s*24\.99/);
  assert.deepEqual(marketDirectory(false).map(market => market.id), ["bd", "us"]);
  assert.deepEqual(marketDirectory(true).map(market => market.id), ["bd", "us", "ca"]);
  assert.equal(isStorefrontMarketId("ca", false), false);
  assert.equal(markets.ca.checkout, null);
  assert.deepEqual(markets.ca.payments, []);
});

test("canonical account links select the intended market and reject unregistered destinations", () => {
  assert.equal(marketStoreHref("/bd/orders?market=us&source=account", "ca"), "/orders?market=ca&source=account");
  assert.equal(marketStoreHref("/account/addresses?market=ca", "bd"), "/bd/account/addresses");
  assert.equal(marketStoreHref("/bd/account/addresses", "us"), "/account/addresses?market=us");
  const origin = "https://dev.griipbuddy.com";
  assert.equal(marketStoreUrl("/account/addresses", "ca", origin).href, `${origin}/account/addresses?market=ca`);
  assert.throws(() => marketStoreUrl("//unregistered.invalid/account", "ca", origin));
  assert.throws(() => marketStoreUrl("/admin/orders", "ca", origin));
});

test("the third market requires both explicit opt-in and the isolated dev profile", () => {
  const env = { ...process.env, GRIIP_FIXTURE_MARKET: "ca", GRIIP_HYBRID_STOREFRONT: "1", GRIIP_MARKETPLACE_PREVIEW: "1",
    COMMERCE_MODE: "local", DATABASE_URL: "postgresql://127.0.0.1/griipbuddy_hybrid_test" };
  const previous = process.env;
  try {
    process.env = env;
    assert.equal(fixtureMarketEnabled(), true);
    process.env.DATABASE_URL = "postgresql://127.0.0.1/griipbuddy_dev";
    assert.equal(fixtureMarketEnabled(), false);
    process.env.COMMERCE_MODE = "production";
    process.env.DATABASE_URL = "postgresql://127.0.0.1/griipbuddy_hybrid_test";
    assert.equal(fixtureMarketEnabled(), false);
  } finally {
    process.env = previous;
  }
});
