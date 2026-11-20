import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import "../../scripts/load-env.ts";
import { POST } from "../../src/app/api/staff/workflows/agent/route.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { marketDay, shiftCalendarDay } from "../../src/lib/market-calendar.ts";
import { marketConfiguration } from "../../src/lib/market-config.ts";

requireLocalDatabase("griipbuddy_test");

test("delegated agent dry-run is read-only, draft submission is idempotent, and grants stay authoritative", async () => {
  const db = getDb();
  const actor = randomUUID();
  const agentId = randomUUID();
  const draftId = randomBytes(32).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const previous = [process.env.GRIIP_WORKFLOW_AGENTS, process.env.GRIIP_WORKFLOW_POLICY];
  process.env.GRIIP_WORKFLOW_AGENTS = JSON.stringify([{ id: agentId, staffId: actor, role: "MERCHANDISER", markets: ["bd"], scope: "test",
    tokenSha256: createHash("sha256").update(token).digest("hex") }]);
  process.env.GRIIP_WORKFLOW_POLICY = JSON.stringify([{ marketId: "bd", test: true, role: "MERCHANDISER", action: "HOME_DRAFT", mode: "DRAFT_ONLY", version: "local-agent-test" }]);
  const market = marketConfiguration("bd");
  const day = marketDay(new Date(), market.timeZone);
  const from = shiftCalendarDay(day, -3)!;
  const to = shiftCalendarDay(day, -1)!;
  const request = { marketId: "bd", scope: "test", action: "HOME_DRAFT", draftId };
  const send = (body: object, secret = token) => POST(new Request("http://127.0.0.1/api/staff/workflows/agent", {
    method: "POST", headers: { "content-type": "application/json", "x-griip-workflow-token": secret }, body: JSON.stringify(body),
  }));
  try {
    await db.user.create({ data: { id: actor, name: "Agent scope fixture", email: `${actor}@example.test`, staff: {
      create: { role: "PACKER", active: true, marketGrants: { create: [{ marketId: "bd", reporting: true, merchandising: true }] } },
    } } });
    await db.intelligenceDraft.create({ data: {
      id: draftId, kind: "COLLECTION", test: true, marketId: "bd", sourceId: "agent-permission-fixture", actorId: actor,
      from: new Date(`${from}T00:00:00.000Z`), through: new Date(`${to}T00:00:00.000Z`), evidence: {
        marketId: "bd", test: true, sourceId: "agent-permission-fixture", from, to, productId: "p-lamp", title: "Catalog demand fixture",
        facts: ["A verified shop metric is stored on the saved fixture insight."], hypothesis: "Review the selected product on the homepage.",
        href: "/staff/intelligence?market=bd&scope=test",
      },
    } });

    const wrongToken = await send({ ...request, mode: "preview" }, randomBytes(32).toString("base64url"));
    assert.equal(wrongToken.status, 404);
    for (const patch of [{ marketId: "us" }, { scope: "live" }, { action: "PURCHASE_PROPOSAL" }]) {
      assert.equal((await send({ ...request, mode: "preview", ...patch })).status, 404);
    }
    assert.equal((await send({ ...request, mode: "propose", budgetMinor: 10_000 })).status, 400);

    const preview = await send({ ...request, mode: "preview" });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("cache-control") ?? "", /no-store/);
    const dryRun = await preview.json();
    assert.equal(dryRun.executed, false);
    assert.equal(dryRun.policy.mode, "DRAFT_ONLY");
    assert.equal(typeof dryRun.eligible, "boolean");
    assert.equal(await db.operationalWorkflow.count({ where: { ownerId: actor } }), 0);

    const first = await send({ ...request, mode: "propose" });
    const second = await send({ ...request, mode: "propose" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const saved = await first.json();
    assert.equal(saved.workflowId, (await second.json()).workflowId);
    assert.equal(saved.status, "DRAFT");
    assert.equal(saved.executed, false);
    const row = await db.operationalWorkflow.findUniqueOrThrow({ where: { id: saved.workflowId }, include: { job: true, events: true } });
    assert.equal(row.ownerId, actor);
    assert.equal(row.agentRole, "MERCHANDISER");
    assert.equal(row.job, null);
    const created = row.events.filter(event => event.event === "DRAFT_CREATED");
    assert.equal(created.length, 1);
    const audit = created[0].detail;
    assert.ok(audit && typeof audit === "object" && !Array.isArray(audit));
    assert.equal(audit.agentId, agentId);

    await db.staffAccess.update({ where: { userId: actor }, data: { active: false } });
    assert.equal((await send({ ...request, mode: "propose" })).status, 404);
  } finally {
    const actorRows = await db.operationalWorkflow.findMany({ where: { ownerId: actor }, select: { id: true } });
    await db.operationalWorkflowEvent.deleteMany({ where: { workflowId: { in: actorRows.map(row => row.id) } } });
    await db.operationalWorkflow.deleteMany({ where: { ownerId: actor } });
    await db.intelligenceDraft.deleteMany({ where: { id: draftId } });
    await db.user.deleteMany({ where: { id: actor } });
    for (const [key, value] of [["GRIIP_WORKFLOW_AGENTS", previous[0]], ["GRIIP_WORKFLOW_POLICY", previous[1]]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.$disconnect();
  }
});
