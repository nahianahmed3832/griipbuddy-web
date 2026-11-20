import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { marketRequestHeader } from "../../src/config/regional-path.ts";
import { proxy } from "../../src/proxy.ts";
import { POST as selectRegion } from "../../src/app/api/marketplace/region/route.ts";

test("bound storefront origin outranks client market inputs and rejects a planned host", async t => {
  const bound = "https://bd.example.invalid";
  const shared = "https://shared.example.invalid";
  const future = "https://us.example.invalid";
  const config = {
    COMMERCE_MODE: "local", GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "0",
    BETTER_AUTH_URL: bound,
    GRIIP_MARKET_CONFIGURATION: JSON.stringify({
      bd: { storefrontOrigins: [bound] }, us: { storefrontOrigins: [future], status: "planned" },
    }),
  };
  const previous = Object.keys(config).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const spoofed = { [marketRequestHeader]: "us", cookie: "griipbuddy-market=us" };
  const response = await proxy(new NextRequest(bound + "/account?market=us", { headers: spoofed }));
  assert.equal(response.headers.get(`x-middleware-request-${marketRequestHeader}`), "bd");
  assert.equal((await proxy(new NextRequest(future + "/account", { headers: spoofed }))).status, 404);
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ bd: { storefrontOrigins: [bound] } });
  const sharedResponse = await proxy(new NextRequest(shared + "/account?market=us", { headers: spoofed }));
  assert.equal(sharedResponse.headers.get(`x-middleware-request-${marketRequestHeader}`), "us");
  const sellerResponse = await proxy(new NextRequest(shared + "/seller/orders?market=us"));
  assert.equal(sellerResponse.headers.get(`x-middleware-request-${marketRequestHeader}`), "us");
  assert.equal(sellerResponse.headers.get("Cache-Control"), "private, no-store");
  const boundSeller = await proxy(new NextRequest(bound + "/seller/listings?market=us", { headers: spoofed }));
  assert.equal(boundSeller.headers.get(`x-middleware-request-${marketRequestHeader}`), "bd");
  const select = (region: string) => selectRegion(new Request(bound + "/api/marketplace/region", {
    method: "POST", headers: { origin: bound, "content-type": "application/json" }, body: JSON.stringify({ region }),
  }));
  assert.equal((await select("us")).status, 409);
  assert.equal((await select("bd")).status, 200);
});
