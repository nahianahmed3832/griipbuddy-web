import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { canReadDevAdminOrders, readDevAdminOrderQuery } from "../src/lib/staff/dev-admin-orders.ts";

test("the order projection requires a matching server credential and the protected staging profile", () => {
  const token = randomBytes(32).toString("hex");
  const environment = {
    COMMERCE_MODE: "staging", GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1",
    BETTER_AUTH_URL: "https://dev.griipbuddy.com", GRIIP_HYBRID_ADMIN_ORDERS_TOKEN: token,
    DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db:5432/griipbuddy_hybrid_demo",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    assert.equal(canReadDevAdminOrders(null), false);
    assert.equal(canReadDevAdminOrders(`Bearer ${"0".repeat(64)}`), false);
    assert.equal(canReadDevAdminOrders(`Bearer ${token}`), true);
    process.env.DATABASE_URL = "postgresql://griipbuddy_demo:fixture@db:5432/griipbuddy_production";
    assert.equal(canReadDevAdminOrders(`Bearer ${token}`), false);
    Object.assign(process.env, environment, { COMMERCE_MODE: "production" });
    assert.equal(canReadDevAdminOrders(`Bearer ${token}`), false);
    Object.assign(process.env, environment, { GRIIP_HYBRID_ADMIN_ORDERS_TOKEN: "short" });
    assert.equal(canReadDevAdminOrders("Bearer short"), false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the query exposes bounded reference search and validates cursor and order identity", () => {
  const id = randomUUID();
  const createdAt = new Date("2026-11-17T00:00:00.000Z");
  const after = Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
  const query = (value: string) => readDevAdminOrderQuery(new URLSearchParams(value));
  assert.deepEqual(query(`limit=10&search=GB-12&after=${after}`), { kind: "list", limit: 10, search: "GB-12", after: { createdAt, id } });
  assert.deepEqual(query(`id=${id}`), { kind: "detail", id });
  for (const value of ["limit=51", "limit=0", "after=malformed", "search=@email", "source=prod", "limit=1&limit=2", `id=${id}&limit=5`]) {
    assert.equal(query(value), null);
  }
  assert.deepEqual(query("view=workspace&q=BD-&from=2026-11-16&to=2026-11-17&creator=GUEST"),
    { kind: "workspace", filters: { view: "workspace", q: "BD-", from: "2026-11-16", to: "2026-11-17", creator: "GUEST" } });
  for (const value of ["view=workspace&creator=owner", "view=workspace&from=2026-11-18&to=2026-11-17",
    "view=workspace&from=2026-02-31", "view=workspace&sku=first&sku=second"]) assert.equal(query(value), null);
});
