import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { readPublishedHomepage } from "../../src/lib/catalog/homepage-content.ts";
import { scopeKey } from "../../src/lib/catalog/homepage-contract.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { marketDay, shiftCalendarDay } from "../../src/lib/market-calendar.ts";
import { marketConfiguration } from "../../src/lib/market-config.ts";
import { stableMeasurementId } from "../../src/lib/measurement/domain.ts";
import { workflowAdapters } from "../../src/lib/workflows/adapters.ts";
import { recordConversionCorrection } from "../../src/lib/workflows/conversion.ts";
import { evaluateWorkflowOutcome } from "../../src/lib/workflows/outcomes.ts";
import { createWorkflow, decideWorkflow } from "../../src/lib/workflows/service.ts";
import type { WorkflowInput } from "../../src/lib/workflows/types.ts";
import { dryRunWorkflow, runDueWorkflowReviews, runNextWorkflow } from "../../src/lib/workflows/worker.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("homepage workflow mutates the real scoped editor, reviews exact fixture impressions and rolls back atomically", async () => {
  const marker = randomUUID();
  const actor = { staffId: (await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true }, select: { userId: true } })).userId };
  const marketId = "bd" as const;
  const { defaultLocale: locale, timeZone } = marketConfiguration(marketId);
  const key = scopeKey({ marketId, locale });
  const targetKey = `homepage:${marketId}:${locale}`;
  const releaseIds: string[] = [];
  const created: string[] = [];
  const journeyIds = [randomUUID(), randomUUID()];
  const evidenceId = stableMeasurementId("operational-homepage-test", marker);
  const policy = process.env.GRIIP_WORKFLOW_POLICY;
  const start = new Date();
  const now = (offset: number) => new Date(+start + offset);
  const to = shiftCalendarDay(marketDay(start, timeZone), -1)!;
  const from = shiftCalendarDay(to, -1)!;
  const productId = "p-lamp";
  const outcomeReviewAt = now(60_000);
  const evidence = { kind: "intelligence-draft", ref: evidenceId, from, to };
  const input = (action: WorkflowInput["action"], payload: WorkflowInput["payload"], overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
    action, marketId, test: true, targetKey, title: `Fixture ${action}`, expectedOutcome: "Reach the measured staging placement target.",
    uncertainty: "Fixture traffic has limited evidential value.", requestKey: `${marker}:${action}`, evidence: [evidence],
    evidenceExpiresAt: now(600_000), outcomeReviewAt, payload, ...overrides,
  });
  async function create(payload: WorkflowInput) {
    const row = await createWorkflow(actor, payload, start);
    created.push(row.id);
    return row;
  }
  async function execute(id: string, at: Date) {
    const queued = await decideWorkflow(actor, id, "ready", { now: at });
    assert.equal(queued.status, "READY", queued.blockReason ?? undefined);
    const processed = await runNextWorkflow({ workflowId: id, adapters: workflowAdapters, now: at });
    assert.ok(processed);
    return db.operationalWorkflow.findUniqueOrThrow({ where: { id }, include: { job: true } });
  }
  assert.equal(await db.homepageContent.count({ where: { key } }), 0, "Expected an isolated locale scope before running this fixture.");
  try {
    process.env.GRIIP_WORKFLOW_POLICY = JSON.stringify(["HOME_DRAFT", "HOME_PUBLISH", "HOME_ROLLBACK", "CONVERSION_TASK"].map(action => ({
      marketId, test: true, action, version: "home-workflow-test", mode: "AUTOMATIC", role: "STAFF",
    })));
    await db.intelligenceDraft.create({ data: {
      actorId: actor.staffId, id: evidenceId, marketId, test: true, kind: "COLLECTION", sourceId: evidenceId,
      from: new Date(`${from}T00:00:00Z`), through: new Date(`${to}T00:00:00Z`),
      evidence: { sourceId: evidenceId, marketId, test: true, productId, from, to, title: "Fixture collection evidence",
        facts: ["The fixture comparison window contains a verified product."], hypothesis: "A curated slot can register measured exposure.",
        href: `/staff/intelligence?market=${marketId}&scope=test` },
    } });
    const investigated = await create(input("CONVERSION_TASK", { area: "funnel", facts: ["Scoped product evidence"], hypotheses: ["Review placement reach"],
      correctiveChange: "Publish the reviewed collection change.", successMetric: "product-to-cart", successThreshold: 1,
    }, { targetKey: `conversion:${marketId}:funnel:${productId}` }));
    assert.equal((await execute(investigated.id, now(1_000))).status, "COMPLETED");

    const proposed = await create(input("HOME_DRAFT", { locale, productIds: [productId], sectionTitle: "Workflow adapter test collection" }));
    await dryRunWorkflow(actor, proposed.id, workflowAdapters, now(2_000));
    assert.equal(await db.homepageContent.count({ where: { key } }), 0);
    const drafted = await execute(proposed.id, now(3_000));
    assert.equal(drafted.status, "COMPLETED", drafted.blockReason ?? undefined);
    assert.equal((await db.homepageContent.findUniqueOrThrow({ where: { key } })).publishedId, null);
    const publish = await create(input("HOME_PUBLISH", { locale, draftWorkflowId: drafted.id, minimumImpressions: 1 }, { evidence: [{ kind: "workflow", ref: drafted.id }] }));
    const applied = await execute(publish.id, now(4_000));
    assert.equal(applied.status, "COMPLETED", applied.blockReason ?? undefined);
    const releaseId = (await db.homepageContent.findUniqueOrThrow({ where: { key } })).publishedId;
    assert.ok(releaseId);
    releaseIds.push(releaseId);

    const correction = await recordConversionCorrection(actor, investigated.id, applied.id, now(5_000));
    assert.ok(correction.outcomeReviewAt > outcomeReviewAt);
    await recordConversionCorrection(actor, investigated.id, applied.id, now(5_000));
    assert.equal(await db.operationalWorkflowEvent.count({ where: { workflowId: investigated.id, event: "CORRECTION_LINKED" } }), 1);

    assert.equal(await evaluateWorkflowOutcome(applied, now(6_000)), null);
    const measurement = (await readPublishedHomepage(db, marketId, locale)).measurement;
    await db.measurementJourney.createMany({ data: [{ id: journeyIds[0], test: true, expiresAt: now(600_000) },
      { id: journeyIds[1], test: true, automated: true, expiresAt: now(600_000) }] });
    await db.measurementEvent.createMany({ data: [
      { id: randomUUID(), kind: "PRODUCT_IMPRESSION", marketId, journeyId: journeyIds[0], productId, placement: "home-curated", homepageConfig: measurement, at: now(10_000) },
      { id: randomUUID(), kind: "PRODUCT_IMPRESSION", marketId, journeyId: journeyIds[1], productId, placement: "home-curated", homepageConfig: measurement, at: now(10_000) },
      { id: randomUUID(), kind: "PRODUCT_IMPRESSION", marketId: "us", journeyId: journeyIds[0], productId, placement: "home-curated", homepageConfig: measurement, at: now(10_000) },
      { id: randomUUID(), kind: "PRODUCT_IMPRESSION", marketId, journeyId: journeyIds[0], productId, placement: "home-curated", homepageConfig: measurement, at: now(80_000) },
    ] });
    const [saved] = await runDueWorkflowReviews({ evaluator: evaluateWorkflowOutcome, workflowId: applied.id, now: now(90_000) });
    assert.equal(saved?.outcome, "SUCCESSFUL");
    assert.equal((saved?.evidence as { observed?: number; causal?: boolean })?.observed, 1);
    assert.equal((saved?.evidence as { observed?: number; causal?: boolean })?.causal, false);

    const rollback = await create(input("HOME_ROLLBACK", { locale, publishWorkflowId: applied.id }, { evidence: [{ kind: "workflow", ref: applied.id }] }));
    const reverted = await execute(rollback.id, now(95_000));
    assert.equal(reverted.status, "COMPLETED", reverted.blockReason ?? undefined);
    assert.equal((await db.homepageContent.findUniqueOrThrow({ where: { key } })).publishedId, null);
    assert.equal((await evaluateWorkflowOutcome(reverted, now(100_000)))?.outcome, "SUCCESSFUL");
  } finally {
    if (policy === undefined) delete process.env.GRIIP_WORKFLOW_POLICY;
    else process.env.GRIIP_WORKFLOW_POLICY = policy;
    await db.operationalWorkflowEvent.deleteMany({ where: { workflowId: { in: created } } });
    await db.operationalWorkflowReview.deleteMany({ where: { workflowId: { in: created } } });
    await db.operationalWorkflowJob.deleteMany({ where: { workflowId: { in: created } } });
    await db.operationalWorkflow.deleteMany({ where: { id: { in: created } } });
    await db.measurementJourney.deleteMany({ where: { id: { in: journeyIds } } });
    await db.intelligenceDraft.deleteMany({ where: { id: evidenceId } });
    await db.homepageContent.updateMany({ where: { key }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: key } });
    await db.homepageContent.deleteMany({ where: { key } });
    if (releaseIds.length) await db.auditEvent.deleteMany({ where: { target: key,
      changes: { path: ["previousReleaseId"], equals: releaseIds[0] } } });
  }
});
