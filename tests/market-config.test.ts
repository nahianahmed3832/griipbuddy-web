import assert from "node:assert/strict";
import { test } from "node:test";
import { marketConfigurations, resolveMarketLocale } from "../src/lib/market-config.ts";

test("the two staging markets use distinct local commercial settings", () => {
  const { bd, us } = marketConfigurations(undefined, false);
  assert.deepEqual([bd.status, bd.currency, bd.locale, bd.timeZone, bd.address.adapter, bd.delivery.coverage],
    ["staging", "BDT", "en-BD", "Asia/Dhaka", "bd-district", "checkout-policy"]);
  assert.deepEqual([us.status, us.currency, us.locale, us.timeZone, us.address.adapter, us.delivery.coverage],
    ["staging", "USD", "en-US", "America/New_York", "us-postal", "provider-service"]);
  assert.ok(bd.payments.some(entry => entry.method === "COD" && entry.enabled && entry.evidence === "sandbox"));
  assert.ok(us.payments.some(entry => entry.method === "PAYPAL" && entry.enabled && entry.evidence === "sandbox"));
});

test("configuration rejects unknown markets, incomplete live status, incompatible payments and shared live inventory", () => {
  assert.equal(marketConfigurations(undefined, true).bd.status, "paused");
  assert.equal(marketConfigurations(undefined, true).bd.catalog.inventory, "market-locations");
  assert.throws(() => marketConfigurations('{"unregistered":{}}', false));
  assert.throws(() => marketConfigurations('{"us":{"status":"active"}}', true), /require payment/);
  assert.throws(() => marketConfigurations(JSON.stringify({
    bd: { payments: [{ method: "PAYPAL", adapter: "paypal", evidence: "sandbox", enabled: true }] },
  }), false), /incompatible/);

  const active = { status: "active",
    payments: [{ method: "COD", adapter: "native-cod", evidence: "production", enabled: true }],
    fulfillment: [{ adapter: "manual", evidence: "production" }],
    returns: [{ adapter: "manual", evidence: "production" }],
  };
  assert.equal(marketConfigurations(JSON.stringify({ bd: active }), true).bd.status, "active");
  assert.throws(() => marketConfigurations(JSON.stringify({ bd: { ...active,
    catalog: { eligibility: "market-offer", sellerPermission: "market-grant", inventory: "shared-legacy" },
  } }), true), /requires market-scoped/);
});

test("locale preference is scoped to the selected market and respects accepted language quality", () => {
  const { bd, us } = marketConfigurations('{"us":{"languages":["en-US","en-GB"]}}', false);
  assert.equal(resolveMarketLocale(bd, "en-GB", "en-US,en;q=.8"), "en-BD");
  assert.equal(resolveMarketLocale(us, "en-gb", "en-US"), "en-GB");
  assert.equal(resolveMarketLocale(us, null, "en-US;q=.2,en-GB;q=.9"), "en-GB");
  assert.equal(resolveMarketLocale(us, null, "en-GB;q=0,en"), "en-US");
  assert.equal(resolveMarketLocale(us, null, null), "en-US");
  assert.throws(() => marketConfigurations('{"us":{"languages":["en-GB"]}}', false), /default locale/);
});
