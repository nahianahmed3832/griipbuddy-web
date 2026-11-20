import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { runCatalogCommand } from "../../src/lib/catalog/admin-api.ts";
import { handleMainAdminCatalog } from "../../src/lib/catalog/main-admin-api.ts";
import { rebuildCatalogSearchIndexes } from "../../src/lib/catalog/search-maintenance.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("the signed main admin manages shared aliases and guards audited local index maintenance", async t => {
  const suffix = randomBytes(5).toString("hex");
  const owner = { id: `search-owner-${suffix}`, legacyId: randomBytes(12).toString("hex"), role: "OWNER" } as const;
  const scoped = { id: `search-scoped-${suffix}`, legacyId: randomBytes(12).toString("hex"), role: "PACKER" } as const;
  const deviceId = `search-device-${suffix}`;
  const secret = randomBytes(48).toString("hex");
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    GRIIP_MAIN_ADMIN_CATALOG_ORIGIN: "http://127.0.0.1:4361",
    GRIIP_MAIN_ADMIN_CATALOG_SECRET: secret,
    GRIIP_MAIN_ADMIN_CATALOG_ACTORS: JSON.stringify({ [owner.legacyId]: owner.id, [scoped.legacyId]: scoped.id }),
  });
  t.after(async () => {
    for (const name of ["GRIIP_MAIN_ADMIN_CATALOG_ORIGIN", "GRIIP_MAIN_ADMIN_CATALOG_SECRET", "GRIIP_MAIN_ADMIN_CATALOG_ACTORS"]) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    await db.deviceModelAlias.deleteMany({ where: { modelId: deviceId } });
    await db.deviceModel.deleteMany({ where: { id: deviceId } });
    await db.auditEvent.deleteMany({ where: { actorId: owner.id } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, scoped.id] } } });
  });
  for (const actor of [owner, scoped]) {
    await db.user.create({ data: { id: actor.id, name: `Search fixture ${actor.role}`, email: `${actor.id}@example.invalid`,
      staff: { create: { role: actor.role, ...(actor.role === "PACKER" && {
        marketGrants: { create: { marketId: "bd", commercial: true, merchandising: true } },
      }) } },
    } });
  }

  async function send(request: object, expectedStatus: number, actor: typeof owner | typeof scoped = owner, marketId = "bd") {
    const body = JSON.stringify({ issuedAt: Date.now(), nonce: randomUUID(), legacyId: actor.legacyId,
      central: actor.role === "OWNER", marketId, request });
    const signature = createHmac("sha256", secret).update("griip-main-admin-catalog-v1\n").update(body).digest("hex");
    const response = await handleMainAdminCatalog(new Request("http://127.0.0.1:3100/api/internal/main-admin-catalog", {
      method: "POST", headers: { "content-type": "application/json", "x-griip-catalog-signature": signature }, body,
    }));
    const payload = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(payload));
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    return payload;
  }

  const device = { id: deviceId, brand: "Search fixture", name: `Accessory ${suffix}`, revision: null, aliases: [`Travel ${suffix}`] };
  await send({ action: "device.save", input: device }, 403, scoped);
  await send({ action: "device.save", input: device }, 200);
  await send({ read: "device", id: deviceId }, 403, scoped);
  const initial = await send({ read: "device", id: deviceId }, 200);
  assert.equal(initial.data.device.revision, 0);
  await send({ action: "device.save", input: { ...device, revision: 0, aliases: [`Carry ${suffix}`] } }, 200, owner, "us");
  await send({ action: "device.save", input: { ...device, revision: 0 } }, 409);
  assert.deepEqual((await send({ read: "devices", q: `Travel ${suffix}` }, 200)).data.matches, []);
  const edited = await send({ read: "devices", q: `Carry ${suffix}` }, 200);
  assert.deepEqual(edited.data.matches.map((row: { id: string; revision: number }) => [row.id, row.revision]), [[deviceId, 1]]);
  assert.equal((await send({ read: "device", id: deviceId }, 200)).data.history.length, 2);

  await send({ read: "search-status" }, 403, scoped);
  await send({ action: "search.rebuild", input: {} }, 403, scoped);
  const indexes = (await send({ read: "search-status" }, 200)).data;
  assert.equal(indexes.canRebuild, true);
  assert.equal(indexes.tables.length, 15);
  assert.ok(indexes.tables.every((row: { usable: number; state: string }) => row.usable > 0 && row.state === "ready"));
  await assert.rejects(runCatalogCommand({ action: "search.rebuild", input: {} }, { kind: "staff", id: owner.id, role: "OWNER" },
    async () => "bd"), { name: "Error", code: "invalid_input" });
  await send({ action: "search.rebuild", input: { table: "Order" } }, 400);

  const reconciliation = await send({ action: "search.reconcile", input: {} }, 200, owner, "us");
  assert.equal(reconciliation.data.marketId, "us");
  assert.equal(reconciliation.data.status, "ok");
  assert.ok(reconciliation.data.checkedCards > 0);
  assert.equal(reconciliation.data.exactProbe, "matched");
  const beforeCount = await db.variant.count();
  async function fileNode() {
    const [row] = await db.$queryRaw<{ id: string }[]>`SELECT pg_relation_filenode('"DeviceModelAlias_pkey"'::regclass)::text AS id`;
    return row.id;
  }
  const beforeNode = await fileNode();
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(289561, 11)`;
    const locked = await send({ action: "search.rebuild", input: {} }, 409);
    assert.equal(locked.error.code, "conflict");
  });
  assert.equal(await fileNode(), beforeNode);
  assert.equal((await send({ action: "search.rebuild", input: {} }, 200)).data.rebuiltTables, 15);
  assert.notEqual(await fileNode(), beforeNode);
  assert.equal(await db.variant.count(), beforeCount);
  const history = (await send({ read: "search-status" }, 200, owner, "us")).data.history
    .filter((row: { actor?: { name: string } }) => row.actor?.name === "Search fixture OWNER");
  assert.deepEqual(history.map((row: { changes: { operation: string } }) => row.changes.operation), ["rebuild", "reconcile"]);

  process.env.COMMERCE_MODE = "production";
  try {
    await send({ action: "search.rebuild", input: {} }, 404);
    await assert.rejects(rebuildCatalogSearchIndexes(), { code: "forbidden" });
  } finally {
    process.env.COMMERCE_MODE = savedEnv.COMMERCE_MODE;
  }
});
