import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { mergeHomepage, scopeKey, type HomepageScope } from "../../src/lib/catalog/homepage-contract.ts";
import { publishedHomepage } from "../../src/lib/catalog/homepage-content.ts";
import { recommendationConfig } from "../../src/lib/catalog/recommendation-config.ts";
import { publishHomepage, saveHomepageDraft, saveHomepageRecommendations, saveStaffMarketGrant } from "../../src/lib/staff/homepage.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("recommendation drafts inherit, publish and roll back with market authorization and audit history", async () => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const staffId = randomUUID();
  const bd: HomepageScope = { marketId: "bd", locale: "en-BD" };
  const us: HomepageScope = { marketId: "us", locale: "en-US" };
  const keys = [scopeKey({}), scopeKey(bd), scopeKey(us)];
  assert.equal(await db.homepageContent.count({ where: { key: { in: keys } } }), 0, "Policy test expects unused isolated scopes.");
  await db.user.create({ data: { id: staffId, name: "Recommendation policy fixture", email: `${staffId}@example.test`,
    staff: { create: { role: "PACKER" } } } });
  try {
    await saveStaffMarketGrant(owner.userId, staffId, "bd", true, false);
    const globalPolicy = { behavioralEnabled: true, placements: { recommended: { fallback: ["p-tote"] } } };
    const bdPolicy = { behavioralEnabled: false, placements: { recommended: { fallback: [], excludes: ["p-notebooks"] } } };
    await assert.rejects(saveHomepageRecommendations(staffId, {}, 0, globalPolicy), /permission/);
    await assert.rejects(saveHomepageRecommendations(staffId, us, 0, bdPolicy), /permission/);
    await assert.rejects(saveHomepageRecommendations(staffId, bd, 0, { placements: { bad: { enabled: false } } }), /placements/);
    await assert.rejects(saveHomepageRecommendations(staffId, bd, 0, { placements: { similar: { strategy: "history" } } }), /supported by this placement/);
    await saveHomepageRecommendations(owner.userId, {}, 0, globalPolicy);
    await publishHomepage(owner.userId, {}, 1);
    await saveHomepageRecommendations(staffId, bd, 0, bdPolicy);
    await assert.rejects(saveHomepageRecommendations(staffId, bd, 0, bdPolicy), /changed/);
    assert.equal((await recommendationConfig("bd", "en-BD")).behavioralEnabled, true);
    const preview = await recommendationConfig("bd", "en-BD", keys[1]);
    assert.equal(preview.behavioralEnabled, false);
    assert.deepEqual(preview.placements.recommended.fallback, []);
    assert.equal(preview.placements.recommended.fallbackConfigured, true);
    assert.deepEqual(preview.placements.recommended.excludes, ["p-notebooks"]);

    await saveHomepageDraft(staffId, bd, 1, {
      sections: [{ key: "hero", type: "BANNER", title: "BD policy fixture", position: 1 }],
    });
    await publishHomepage(staffId, bd, 2);
    const published = await recommendationConfig("bd", "en-BD");
    const unitedStates = await recommendationConfig("us", "en-US");
    assert.equal(published.behavioralEnabled, false);
    assert.notEqual(published.version, preview.version);
    assert.equal(unitedStates.behavioralEnabled, true);
    assert.deepEqual(unitedStates.placements.recommended.fallback, ["p-tote"]);
    assert.deepEqual(unitedStates.placements.recommended.excludes, []);

    const original = await db.homepageContent.findUniqueOrThrow({ where: { key: keys[1] }, select: { publishedId: true } });
    await saveHomepageRecommendations(staffId, bd, 3, {});
    await publishHomepage(staffId, bd, 4);
    assert.equal((await recommendationConfig("bd", "en-BD")).behavioralEnabled, true);
    await publishHomepage(staffId, bd, 5, original.publishedId!);
    assert.equal((await recommendationConfig("bd", "en-BD")).behavioralEnabled, false);
    assert.equal(mergeHomepage((await publishedHomepage("bd", "en-BD")).layers).find(section => section.key === "hero")?.title, "BD policy fixture");
    const audits = await db.auditEvent.findMany({ where: { target: keys[1], actorId: staffId, action: "MERCHANDISING_REVIEW" },
      orderBy: { createdAt: "asc" } });
    const recommendationSteps = audits.map(row => (row.changes as { step: string }).step)
      .filter(step => step.startsWith("recommendation-"));
    assert.deepEqual(recommendationSteps, [
      "recommendation-draft-saved", "recommendation-policy-published", "recommendation-draft-saved",
      "recommendation-policy-published", "recommendation-policy-restored",
    ]);
  } finally {
    await db.auditEvent.deleteMany({ where: { action: "MERCHANDISING_REVIEW", target: { in: keys } } });
    await db.homepageContent.updateMany({ where: { key: { in: keys } }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: { in: keys } } });
    await db.homepageContent.deleteMany({ where: { key: { in: keys } } });
    await db.user.delete({ where: { id: staffId } });
  }
});
