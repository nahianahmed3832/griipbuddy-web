import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { hashPassword } from "better-auth/crypto";
import "../../scripts/load-env.ts";
import { POST as selectCatalogMarket } from "../../src/app/api/staff/catalog/context/route.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { staffAuth } from "../../src/lib/staff/auth.ts";
import { canUseMarket } from "../../src/lib/staff/market-access.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("catalog context authenticates exact role and action grants and rechecks revoked sessions", async t => {
  const origin = new URL(process.env.BETTER_AUTH_URL!).origin;
  const password = randomBytes(24).toString("hex");
  const hash = await hashPassword(password);
  const ids: string[] = [];
  t.after(async () => { await db.user.deleteMany({ where: { id: { in: ids } } }); });

  async function staff(role: "OWNER" | "PACKER", marketId?: "bd" | "us") {
    const id = randomUUID();
    const email = id + "@example.invalid";
    await db.user.create({ data: {
      id, name: "Synthetic staff", email, emailVerified: true,
      staff: { create: { role, marketGrants: {
        create: marketId === "bd" ? [{ marketId, operations: true }]
          : marketId === "us" ? [{ marketId, merchandising: true }] : [],
      } } },
      accounts: { create: { id: randomUUID(), providerId: "credential", accountId: id, password: hash } },
    } });
    ids.push(id);
    const response = await staffAuth().handler(new Request(origin + "/api/staff/sign-in/email", {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }));
    assert.equal(response.status, 200);
    return { id, cookie: response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ") };
  }

  const core = await staff("OWNER");
  const bdOperations = await staff("PACKER", "bd");
  const usMerchandising = await staff("PACKER", "us");
  const choose = (body: Record<string, string>, cookie?: string) => selectCatalogMarket(new Request(
    origin + "/api/staff/catalog/context", { method: "POST", body: JSON.stringify(body),
      headers: { origin, "content-type": "application/json", ...(cookie && { cookie }) } },
  ));

  assert.equal((await choose({ marketId: "us" })).status, 401);
  assert.equal((await choose({ marketId: "unknown" }, core.cookie)).status, 400);
  assert.equal((await choose({ marketId: "bd", currency: "USD" }, core.cookie)).status, 400);
  assert.equal((await choose({ marketId: "bd" }, core.cookie)).status, 200);
  assert.equal((await choose({ marketId: "us" }, core.cookie)).status, 200);
  assert.equal(await canUseMarket(bdOperations.id, "bd", "operations", db), true);
  assert.equal(await canUseMarket(bdOperations.id, "us", "operations", db), false);
  assert.equal((await choose({ marketId: "us" }, bdOperations.cookie)).status, 403);
  assert.equal((await choose({ marketId: "bd" }, bdOperations.cookie)).status, 403);
  assert.equal((await choose({ marketId: "bd" }, usMerchandising.cookie)).status, 403);
  assert.equal((await choose({ marketId: "us", permission: "commercial" }, usMerchandising.cookie)).status, 403);
  const allowed = await choose({ marketId: "us" }, usMerchandising.cookie);
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { data: { marketId: "us" } });

  await db.staffMarketAccess.update({
    where: { userId_marketId: { userId: usMerchandising.id, marketId: "us" } }, data: { merchandising: false },
  });
  assert.equal((await choose({ marketId: "us" }, usMerchandising.cookie)).status, 403);
  await db.staffAccess.update({ where: { userId: bdOperations.id }, data: { active: false } });
  assert.equal((await choose({ marketId: "bd" }, bdOperations.cookie)).status, 401);
  assert.equal(await canUseMarket(bdOperations.id, "bd", "operations", db), false);
});
