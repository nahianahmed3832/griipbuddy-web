import assert from "node:assert/strict";
import test from "node:test";
import { activeStaffActor } from "../src/lib/access/actors.ts";
import { checkoutDestination, checkoutMarketHeader } from "../src/lib/commerce/market-commerce.ts";
import { browserCredentialsPresent } from "../src/lib/db/http.ts";
import { marketConfigurations, marketContext, marketForStorefrontOrigin, resolveMarketScope } from "../src/lib/market-config.ts";

test("market configuration provides scoped origin, locale, currency and routing boundaries", t => {
  const previous = process.env.GRIIP_MARKET_CONFIGURATION;
  t.after(() => {
    if (previous === undefined) delete process.env.GRIIP_MARKET_CONFIGURATION;
    else process.env.GRIIP_MARKET_CONFIGURATION = previous;
  });
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ us: {
    storefrontOrigins: ["https://us.example.invalid"], regionalService: { id: "native-commerce", deployment: "fixture-us" },
  } });
  const market = resolveMarketScope("us", "USD");
  assert.ok(market);
  const context = marketContext(market);
  assert.deepEqual(context.storefront, { pathPrefix: "", origins: ["https://us.example.invalid"] });
  assert.deepEqual(context.regionalService, { id: "native-commerce", deployment: "fixture-us" });
  assert.equal(context.minorDigits, 2);
  assert.deepEqual(context.supportedLocales, ["en-US"]);
  assert.equal(resolveMarketScope("us", "BDT"), null);
  assert.equal(resolveMarketScope("gb"), null);
  assert.equal(marketForStorefrontOrigin("https://us.example.invalid.attacker.invalid"), undefined);
  assert.equal(checkoutDestination(new Headers(), "bd", "https://us.example.invalid"), "us");
  assert.equal(checkoutDestination(new Headers({ [checkoutMarketHeader]: "bd" }), "bd", "https://us.example.invalid"), null);
  assert.equal(checkoutDestination(new Headers({ [checkoutMarketHeader]: "us" }), "bd"), "us");
  assert.equal(checkoutDestination(new Headers({ [checkoutMarketHeader]: "unknown" }), "bd"), null);
  assert.throws(() => marketConfigurations(JSON.stringify({
    bd: { storefrontOrigins: ["https://same.example.invalid"] }, us: { storefrontOrigins: ["https://same.example.invalid"] },
  }), false), /only one market/);
  assert.throws(() => marketConfigurations(JSON.stringify({ us: { storefrontOrigins: ["https://us.example.invalid/any"] } }), false));
});

test("staff principals and server-only ingress fail closed without promoting unrecognized staff roles", () => {
  assert.deepEqual(activeStaffActor({ userId: "owner", role: "OWNER", active: true }), {
    id: "owner", kind: "core-admin", role: "OWNER",
  });
  assert.deepEqual(activeStaffActor({ userId: "packer", role: "PACKER", active: true }), {
    id: "packer", kind: "market-staff", role: "PACKER",
  });
  assert.equal(activeStaffActor({ userId: "retired", role: "OWNER", active: false }), null);
  assert.equal(activeStaffActor({ userId: "unknown", role: "SUPER_ADMIN", active: true }), null);
  assert.equal(browserCredentialsPresent(new Headers({ "sec-fetch-mode": "cors" })), false);
  for (const header of ["origin", "cookie", "sec-fetch-site", "sec-fetch-dest"]) {
    assert.equal(browserCredentialsPresent(new Headers({ [header]: "fixture" })), true);
  }
});
