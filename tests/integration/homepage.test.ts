import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import sharp from "sharp";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { homepageDemand } from "../../src/lib/catalog/homepage-demand.ts";
import { mergeHomepage, scopeKey, type HomepageScope } from "../../src/lib/catalog/homepage-contract.ts";
import { isPublishedHomepageMedia, publishedHomepage, readPublishedHomepage } from "../../src/lib/catalog/homepage-content.ts";
import { visibleHomepageSection } from "../../src/lib/catalog/homepage-layout.ts";
import { marketConfiguration } from "../../src/lib/market-config.ts";
import { browserMeasurementSchema, type BrowserMeasurement } from "../../src/lib/measurement/schema.ts";
import { recordMeasurement } from "../../src/lib/measurement/server.ts";
import { canEditHomepage, publishHomepage, publishHomepageRecommendations, saveHomepageDraft, saveStaffMarketGrant } from "../../src/lib/staff/homepage.ts";
import { storeHomepageImage } from "../../src/lib/staff/homepage-media.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("market templates publish, enforce editing grants, and restore history within scope", async () => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const staffId = randomUUID();
  const scopes: HomepageScope[] = [{ marketId: "bd", locale: "en-BD" }, { marketId: "us", locale: "en-US" }];
  const scopeKeys = scopes.map(scopeKey);
  assert.equal(await db.homepageContent.count({ where: { key: { in: scopeKeys } } }), 0, "Template test expects unused isolated scopes.");
  await db.user.create({ data: { id: staffId, name: "Homepage fixture", email: `${staffId}@example.test`,
    staff: { create: { role: "PACKER" } } } });
  const draft = (title: string, startsLocal?: string) => ({
    sections: [{ key: "hero", type: "BANNER", title, position: 1, startsLocal }],
  });
  try {
    await saveStaffMarketGrant(owner.userId, staffId, "bd", true, false);
    assert.equal(await canEditHomepage(staffId, scopes[0]), true);
    assert.equal(await canEditHomepage(staffId, scopes[1]), false);
    assert.equal(await canEditHomepage(staffId, {}), false);
    await assert.rejects(saveHomepageDraft(staffId, scopes[1], 0, draft("Wrong market")), /permission/);
    await assert.rejects(saveHomepageDraft(owner.userId, scopes[1], 0, draft("Invalid local clock", "2027-03-14T02:30")), /skipped or repeated/);

    await Promise.all([saveHomepageDraft(staffId, scopes[0], 0, draft("Bangladesh local campaign", "2027-01-15T09:00")),
      saveHomepageDraft(owner.userId, scopes[1], 0, draft("United States local campaign", "2027-01-15T09:00"))]);
    await Promise.all([publishHomepage(staffId, scopes[0], 1), publishHomepage(owner.userId, scopes[1], 1)]);
    const published = await Promise.all([publishedHomepage("bd", "en-BD"), publishedHomepage("us", "en-US")]);
    const [bd, us] = published.map(entry => mergeHomepage(entry.layers).find(section => section.key === "hero")!);
    assert.equal(bd.title, "Bangladesh local campaign");
    assert.equal(us.title, "United States local campaign");
    assert.notEqual(published[0].measurement, published[1].measurement);
    const between = new Date("2027-01-15T09:00:00Z");
    assert.equal(visibleHomepageSection(bd, between, "Asia/Dhaka"), true);
    assert.equal(visibleHomepageSection(us, between, "America/New_York"), false);
    assert.equal(visibleHomepageSection(us, new Date("2027-01-15T14:00:00Z"), "America/New_York"), true);

    const first = await db.homepageRelease.findFirstOrThrow({ where: { scopeKey: scopeKeys[0] } });
    await assert.rejects(publishHomepage(owner.userId, scopes[1], 2, first.id), /does not belong/);
    await assert.rejects(saveHomepageDraft(staffId, scopes[0], 1, draft("Old version")), /changed/);
    await saveHomepageDraft(staffId, scopes[0], 2, draft("Current version"));
    await publishHomepage(staffId, scopes[0], 3);
    await publishHomepage(staffId, scopes[0], 4, first.id);
    const restored = await db.homepageContent.findUniqueOrThrow({ where: { key: scopeKeys[0] }, include: { history: true, published: true } });
    assert.equal(restored.history.length, 3);
    assert.equal(restored.published?.restoredFrom, first.id);
    assert.deepEqual(restored.published?.content, first.content);
  } finally {
    await db.homepageContent.updateMany({ where: { key: { in: scopeKeys } }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: { in: scopeKeys } } });
    await db.homepageContent.deleteMany({ where: { key: { in: scopeKeys } } });
    await db.user.delete({ where: { id: staffId } });
  }
});

test("trending counts distinct consented sessions for the selected market and ignores sandbox activity", async () => {
  const at = new Date();
  const journeyId = randomUUID();
  const fixtureId = randomUUID();
  const productId = "test-homepage-demand-" + randomUUID();
  const create = (marketId: "bd" | "us", parent: string, sessionId: string) => ({
    id: randomUUID(), marketId, sessionId, journeyId: parent, productId, kind: "PRODUCT_VIEW" as const,
    at: new Date(+at - 60_000),
  });
  const consent = { expiresAt: new Date(+at + 60_000) };
  await db.measurementJourney.createMany({ data: [{ id: journeyId, test: false, ...consent }, { id: fixtureId, test: true, ...consent }] });
  try {
    const bdSessions = Array.from({ length: 5 }, () => randomUUID());
    const usSession = randomUUID();
    await db.measurementEvent.createMany({ data: [
      ...bdSessions.map(session => create("bd", journeyId, session)),
      ...bdSessions.map(session => create("us", fixtureId, session)),
      ...bdSessions.map(() => create("us", journeyId, usSession)),
    ] });
    const [bd, us] = await Promise.all([homepageDemand("bd", at), homepageDemand("us", at)]);
    assert.ok(bd.trending.includes(productId));
    assert.ok(!us.trending.includes(productId));
  } finally {
    await db.measurementJourney.deleteMany({ where: { id: { in: [journeyId, fixtureId] } } });
  }
});

test("merchandising validates real references, keeps draft media and body private, and audits releases", async () => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const subject = await db.product.findFirstOrThrow({ where: { active: true, publication: "ACTIVE", department: { state: "ACTIVE" } },
    select: { id: true, departmentId: true } });
  const bd = marketConfiguration("bd");
  const us = marketConfiguration("us");
  const scope = { marketId: bd.id, locale: bd.defaultLocale };
  const key = scopeKey(scope);
  assert.equal(await db.homepageContent.count({ where: { key } }), 0);
  const color = `#${randomUUID().slice(0, 6)}`;
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();
  const { src } = await storeHomepageImage(owner.userId, scope, bytes, "image/png");
  const title = "Fixture category spotlight";
  const spotlight = { key: "body-test", type: "CATEGORY_SPOTLIGHT", position: 4, title, categoryId: subject.departmentId,
    bannerImage: { src, alt: "Fixture image" } };
  const product = { key: "curated-test", type: "CURATED", title: "Fixture products", position: 3, productIds: [subject.id] };
  try {
    await assert.rejects(saveHomepageDraft(owner.userId, scope, 0, { sections: [{ ...spotlight, categoryId: "missing-fixture" }] }), /current catalog category/);
    await assert.rejects(saveHomepageDraft(owner.userId, scope, 0, { sections: [{ ...product, productIds: ["missing-fixture"] }] }), /current catalog product/);
    await assert.rejects(saveHomepageDraft(owner.userId, scope, 0, { sections: [{ ...spotlight,
      link: { label: "Wrong collection", href: "/collections/missing-fixture" } }] }), /valid collection/);
    await assert.rejects(saveHomepageDraft(owner.userId, scope, 0, { sections: [{ key: "budget", type: "DEALS", title: "Wrong currency",
      position: 4, budget: { currency: "USD", amountMinor: 500 } }] }), /selected market’s currency/);
    const draft = await saveHomepageDraft(owner.userId, scope, 0, { sections: [spotlight, product] });
    assert.equal(await isPublishedHomepageMedia(src, bd), false);
    const read = async (draftScopeKey?: string) => mergeHomepage((await readPublishedHomepage(db, bd.id, bd.locale, draftScopeKey)).layers);
    assert.equal((await read()).some(section => section.key === spotlight.key), false);
    assert.equal((await read(key)).find(section => section.key === spotlight.key)?.title, title);
    const release = await publishHomepage(owner.userId, scope, draft.revision);
    assert.equal(await isPublishedHomepageMedia(src, bd), true);
    assert.equal(await isPublishedHomepageMedia(src, us), false);

    const pending = await saveHomepageDraft(owner.userId, scope, release.revision, {
      sections: [{ ...spotlight, title: "Pending body update" }, product], recommendations: { behavioralEnabled: true },
    });
    await publishHomepageRecommendations(owner.userId, scope, pending.revision);
    assert.equal((await read()).find(section => section.key === spotlight.key)?.title, title);
    assert.equal((await read(key)).find(section => section.key === spotlight.key)?.title, "Pending body update");
    const audit = await db.auditEvent.findMany({ where: { target: key, actorId: owner.userId,
      OR: ["homepage-draft-saved", "homepage-published"].map(step => ({ changes: { path: ["step"], equals: step } })) } });
    assert.ok(audit.length >= 4);
  } finally {
    await db.homepageContent.updateMany({ where: { key }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: key } });
    await db.homepageContent.deleteMany({ where: { key } });
    await db.auditEvent.deleteMany({ where: { target: { in: [key, `homepage-media:${src.slice(7)}`] }, actorId: owner.userId } });
    await db.catalogMedia.delete({ where: { id: src.slice(7) } });
  }
});

test("published homepage section impressions deduplicate by session and product clicks stay distinct", async () => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const market = marketConfiguration("bd");
  const scope: HomepageScope = { marketId: market.id };
  const key = scopeKey(scope);
  assert.equal(await db.homepageContent.count({ where: { key } }), 0);

  const variant = await db.variant.findUniqueOrThrow({ where: { id: "v-tote-oat" }, select: { id: true, productId: true } });
  const sectionId = "measurement-picks";
  const journeyId = randomUUID();
  const sessionId = randomUUID();
  const placement = "home-curated";
  try {
    const draft = await saveHomepageDraft(owner.userId, scope, 0, {
      sections: [{ key: sectionId, type: "CURATED", title: "Measurement fixture picks", position: 2, productIds: [variant.productId] }],
    });
    await publishHomepage(owner.userId, scope, draft.revision);
    const { measurement: homepageConfig } = await readPublishedHomepage(db, market.id, market.defaultLocale);
    assert.match(homepageConfig, /^home-release-/);
    await db.measurementJourney.create({ data: { id: journeyId, test: true, expiresAt: new Date(Date.now() + 60_000) } });

    function event(action: BrowserMeasurement["action"], fields: Partial<BrowserMeasurement> = {}) {
      return browserMeasurementSchema.parse({
        version: 1, at: new Date().toISOString(), nonce: randomUUID(), sessionId,
        action, marketId: market.id, homepageConfig, sectionId, placement, position: 2, ...fields,
      });
    }
    const product = { productId: variant.productId, variantId: variant.id, position: 1 };
    for (const observation of [
      event("HOMEPAGE_SECTION_IMPRESSION"),
      event("HOMEPAGE_SECTION_IMPRESSION"),
      event("PRODUCT_IMPRESSION", product),
      event("PRODUCT_IMPRESSION", product),
      event("PRODUCT_CLICK", product),
      event("PRODUCT_CLICK", product),
    ]) {
      assert.equal(await recordMeasurement(journeyId, market.id, observation), true);
    }
    assert.equal(await recordMeasurement(journeyId, market.id, event("HOMEPAGE_SECTION_IMPRESSION", { sectionId: "unknown-section" })), false);
    assert.equal(await recordMeasurement(journeyId, market.id, event("PRODUCT_CLICK", { ...product, placement: "home-featured" })), false);

    const rows = await db.measurementEvent.findMany({ where: { journeyId } });
    assert.equal(rows.length, 4);
    assert.equal(rows.filter(row => row.kind === "HOMEPAGE_SECTION_IMPRESSION").length, 1);
    assert.equal(rows.filter(row => row.kind === "PRODUCT_IMPRESSION").length, 1);
    assert.equal(rows.filter(row => row.kind === "PRODUCT_CLICK").length, 2);
    for (const row of rows) {
      assert.deepEqual(row.details, { sectionId });
      assert.equal(row.homepageConfig, homepageConfig);
      assert.equal(row.marketId, market.id);
      assert.equal(row.placement, placement);
      if (row.kind !== "HOMEPAGE_SECTION_IMPRESSION") {
        assert.equal(row.productId, variant.productId);
        assert.equal(row.variantId, variant.id);
      }
    }
  } finally {
    await db.measurementJourney.deleteMany({ where: { id: journeyId } });
    await db.homepageContent.updateMany({ where: { key }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: key } });
    await db.homepageContent.deleteMany({ where: { key } });
    await db.auditEvent.deleteMany({ where: { target: key, actorId: owner.userId } });
  }
});
