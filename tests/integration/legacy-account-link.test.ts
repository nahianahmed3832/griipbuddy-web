import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { POST as link } from "../../src/app/api/account/legacy-link/route.ts";
import { storefrontPath } from "../../src/config/storefront-path.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { shopperAuth } from "../../src/lib/marketplace/auth.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("legacy linking binds a verified source account to the current shopper exactly once", async t => {
  const fixture = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const legacyId = randomBytes(12).toString("hex");
  const credentials = { phone: "01700000000", password: `Fixture-${fixture}` };
  const fixtureOrigin = "http://127.0.0.1:38100";
  const base = new URL(process.env.BETTER_AUTH_URL!).origin;
  const config = {
    GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "0",
    GRIIP_LEGACY_ACCOUNT_LINK_ORIGIN: fixtureOrigin, BD_ORDER_HUB_BRIDGE_TOKEN: secret,
  };
  const previous = Object.keys(config).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, config);
  const emails: string[] = [];
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.shopper.deleteMany({ where: { email: { in: emails } } });
  });

  async function signIn(suffix: string) {
    const email = `${fixture}-${suffix}@example.invalid`;
    emails.push(email);
    const sign = (action: string) => shopperAuth().handler(new Request(new URL(storefrontPath(`/api/shopper-auth/${action}/email`), base), {
      method: "POST", headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ email, password: credentials.password, ...(action === "sign-up" && { name: "M02 synthetic shopper" }) }),
    }));
    assert.equal((await sign("sign-up")).status, 200);
    const result = await sign("sign-in");
    assert.equal(result.status, 200);
    const cookie = result.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    assert.ok(cookie);
    return { id: (await db.shopper.findUniqueOrThrow({ where: { email } })).id, cookie };
  }

  const [owner, other] = [await signIn("owner"), await signIn("other")];
  let reply: "verified" | "wrong-owner" | "wrong-currency" | "unverified" = "verified";
  const operations = new Set<string>();
  const transport = t.mock.method(globalThis, "fetch", async (url: string, request: RequestInit) => {
    assert.equal(url, fixtureOrigin + "/api/v1/customer-orders/link");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    const headers = new Headers(request.headers);
    const timestamp = headers.get("x-griip-bridge-time")!;
    const operation = headers.get("x-griip-operation-id")!;
    assert.match(operation, /^[0-9a-f-]+$/);
    assert.ok(Number(timestamp) > Math.floor(Date.now() / 1000) - 60);
    assert.ok(!operations.has(operation));
    operations.add(operation);
    assert.equal(headers.has("cookie"), false);
    const { shopperId, phone, password, marketId, currency } = JSON.parse(String(request.body));
    assert.equal(marketId, "bd");
    assert.equal(currency, "BDT");
    assert.equal(phone, credentials.phone);
    const signed = JSON.stringify(["griip-legacy-account-link-v1", timestamp, operation, "POST", "/api/v1/customer-orders/link",
      marketId, currency, shopperId, phone, password]);
    assert.equal(headers.get("x-griip-bridge-signature"), createHmac("sha256", Buffer.from(secret, "hex")).update(signed).digest("hex"));
    if (reply === "unverified") return new Response(null, { status: 401 });
    return Response.json({ success: true, data: {
      marketId, currency: reply === "wrong-currency" ? "USD" : currency, shopperId: reply === "wrong-owner" ? other.id : shopperId,
      legacyCustomer: { authority: "legacy-commerce", kind: "customer", id: legacyId },
    } });
  });
  const request = (cookie?: string, origin = base, payload: unknown = credentials) => link(new Request(new URL("/api/account/legacy-link", base), {
    method: "POST", headers: { "content-type": "application/json", origin, ...(cookie && { cookie }) }, body: JSON.stringify(payload),
  }));
  assert.equal((await request()).status, 401);
  assert.equal((await request(owner.cookie, "https://different.example.invalid")).status, 403);
  assert.equal((await request(owner.cookie, base, { ...credentials, shopperId: other.id })).status, 400);
  assert.equal(transport.mock.callCount(), 0);
  reply = "wrong-owner";
  assert.equal((await request(owner.cookie)).status, 503);
  reply = "wrong-currency";
  assert.equal((await request(owner.cookie)).status, 503);
  reply = "unverified";
  assert.equal((await request(owner.cookie)).status, 401);
  assert.equal(await db.shopperLegacyLink.count({ where: { legacyCustomerId: legacyId } }), 0);
  reply = "verified";
  const success = await request(owner.cookie);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { data: { linked: true } });
  assert.equal((await request(owner.cookie)).status, 200);
  assert.equal((await request(other.cookie)).status, 409);
  const bound = await db.shopperLegacyLink.findUniqueOrThrow({ where: { legacyCustomerId: legacyId } });
  assert.equal(bound.shopperId, owner.id);
  assert.equal(bound.marketId, "bd");
  assert.equal(await db.shopperLegacyLink.count({ where: { legacyCustomerId: legacyId } }), 1);
});
