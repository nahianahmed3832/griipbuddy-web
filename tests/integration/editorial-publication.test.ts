import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { editorialSitemapPaths, readPublishedEditorial } from "../../src/lib/catalog/editorial.ts";
import { editorialKey, type EditorialContent } from "../../src/lib/catalog/editorial-contract.ts";
import { homepageReadPayload } from "../../src/lib/catalog/homepage-layout.ts";
import { handleMainAdminCatalog } from "../../src/lib/catalog/main-admin-api.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { marketConfiguration } from "../../src/lib/market-config.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("signed editorial and homepage releases isolate draft, market and language and honor local publication boundaries", async () => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const legacyId = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("hex");
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED = "1";
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN = "http://127.0.0.1:4379";
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_SECRET = secret;
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS = JSON.stringify({ [legacyId]: owner.userId });
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ bd: { languages: ["en-BD", "bn-BD"] } });
  const bd = marketConfiguration("bd");
  assert.ok(bd.languages.includes("bn-BD"));
  const us = marketConfiguration("us");
  const scopes = { bd: "bd:en-BD", us: "us:en-US" };
  const keys = [scopes.bd, editorialKey("bd", "en-BD"), editorialKey("us", "en-US")];
  assert.equal(await db.homepageContent.count({ where: { key: { in: keys } } }), 0);
  let editorialInvalidations = 0, homeInvalidations = 0;
  const signed = async <T>(operation: object, status = 200, marketId: "bd" | "us" = "bd") => {
    const body = JSON.stringify({ legacyId, central: true, marketId, issuedAt: Date.now(), nonce: randomUUID(), request: operation });
    const signature = createHmac("sha256", secret).update("griip-main-admin-catalog-v1\n").update(body).digest("hex");
    const response = await handleMainAdminCatalog(new Request("http://127.0.0.1:3127/api/internal/main-admin-catalog", {
      method: "POST", body, headers: { "content-type": "application/json", "x-griip-admin-channel": "homepage", "x-griip-catalog-signature": signature },
    }), () => { editorialInvalidations++; }, () => { homeInvalidations++; });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    assert.match(response.headers.get("cache-control") ?? "", /private.*no-store/);
    return value.data as T;
  };
  const id = randomUUID();
  const content: EditorialContent = {
    categories: [{ slug: "care", label: "Product care" }],
    documents: [{
      id, kind: "ARTICLE", slug: "care-guide", title: "Fixture care guide", summary: "A locally published test article.",
      body: ["A fictional paragraph for the editorial publication test."], category: "care",
      image: { src: "/editorial/carry.webp", alt: "An everyday carry collection" }, seoTitle: "Fixture care guide title",
      startsLocal: "2027-02-11T09:00", endsLocal: "2027-02-11T10:00",
    }],
  };
  const before = new Date("2027-02-11T02:59:59Z");
  const starts = new Date("2027-02-11T03:00:00Z");
  const ends = new Date("2027-02-11T04:00:00Z");
  const signedRead = { read: "homepage-editorial", homepageScope: scopes.bd };
  try {
    const denied = await handleMainAdminCatalog(new Request("http://127.0.0.1:3127/api/internal/main-admin-catalog", {
      method: "POST", headers: { "x-griip-admin-channel": "homepage" }, body: JSON.stringify(signedRead),
    }));
    assert.equal(denied.status, 401);
    await signed({ ...signedRead, homepageScope: scopes.us }, 403);
    await signed({ ...signedRead, homepageScope: "global:default" }, 400);
    await signed({ action: "homepage.editorial-save", input: { homepageScope: scopes.bd, expectedRevision: 0,
      content: { ...content, documents: [{ ...content.documents[0], category: "missing" }] } } }, 400);
    await signed({ action: "homepage.editorial-save", input: { homepageScope: scopes.us, expectedRevision: 0,
      content: { ...content, documents: [{ ...content.documents[0], startsLocal: "2027-03-14T02:30", endsLocal: undefined }] } } }, 400, "us");
    await signed({ action: "homepage.editorial-save", input: { homepageScope: scopes.bd, expectedRevision: 0, content } });
    const draft = await signed<{ draft: EditorialContent }>(signedRead);
    assert.deepEqual(draft.draft, content);
    assert.deepEqual((await readPublishedEditorial(db, bd.id, bd.locale, starts)).documents, []);
    await signed({ action: "homepage.editorial-publish", input: { homepageScope: scopes.bd, expectedRevision: 0 } }, 409);
    await signed({ action: "homepage.editorial-publish", input: { homepageScope: scopes.bd, expectedRevision: 1 } });
    assert.equal(editorialInvalidations, 1);
    assert.deepEqual((await readPublishedEditorial(db, bd.id, bd.locale, before)).documents, []);
    assert.deepEqual((await readPublishedEditorial(db, bd.id, bd.locale, starts)).documents, content.documents);
    assert.deepEqual((await readPublishedEditorial(db, bd.id, bd.locale, ends)).documents, []);
    assert.deepEqual((await readPublishedEditorial(db, bd.id, "bn-BD", starts)).documents, []);
    assert.deepEqual((await readPublishedEditorial(db, us.id, us.locale, starts)).documents, []);
    const sitemapScopes = [{ id: bd.id, locales: [bd.locale, "bn-BD"] }, { id: us.id, locales: [us.locale] }];
    assert.deepEqual(await editorialSitemapPaths(db, sitemapScopes, before), []);
    assert.deepEqual(await editorialSitemapPaths(db, sitemapScopes, starts), [
      "/blog?market=bd&lang=en-BD", "/blog/care-guide?market=bd&lang=en-BD",
    ]);
    assert.deepEqual(await editorialSitemapPaths(db, sitemapScopes, ends), []);
    await signed({ action: "homepage.editorial-save", input: { homepageScope: scopes.bd, expectedRevision: 2,
      content: { ...content, documents: [{ ...content.documents[0], slug: "changed-public-url" }] } } }, 400);
    await signed({ action: "homepage.editorial-withdraw", input: { homepageScope: scopes.bd, expectedRevision: 2 } });
    assert.equal(editorialInvalidations, 2);
    assert.deepEqual((await readPublishedEditorial(db, bd.id, bd.locale, starts)).documents, []);
    assert.deepEqual(await editorialSitemapPaths(db, sitemapScopes, starts), []);
    assert.deepEqual((await signed<{ draft: EditorialContent }>(signedRead)).draft, content);

    const benefit = { title: "Delivery help", description: "Review the delivery choices before checkout.", destination: "delivery" };
    const panel = { key: "fixture-service-guide", type: "BENEFITS", title: "About your order", position: 10,
      startsLocal: content.documents[0].startsLocal, endsLocal: content.documents[0].endsLocal, benefits: [benefit] };
    const banner = { key: "fixture-seasonal", type: "BANNER", title: "Seasonal fixture", position: 11,
      startsLocal: panel.startsLocal, endsLocal: panel.endsLocal, bannerImage: content.documents[0].image,
      link: { label: "Browse", href: "/shop" } };
    await signed({ action: "homepage.save", input: { homepageScope: scopes.bd, expectedRevision: 0,
      content: { sections: [panel, banner], hiddenSections: [] } } });
    const section = (result: Awaited<ReturnType<typeof homepageReadPayload>>, key: string) => result.sections.find(row => row.id === key);
    assert.equal(section(await homepageReadPayload(bd, { at: starts }), panel.key), undefined);
    const preview = await signed<Awaited<ReturnType<typeof homepageReadPayload>>>({ read: "homepage-preview", homepageScope: scopes.bd,
      marketId: "bd", locale: bd.locale, previewAt: "2027-02-11T09:00" });
    assert.deepEqual(section(preview, panel.key)?.benefits, [benefit]);
    assert.match(section(preview, banner.key)?.destination?.href ?? "", /market=bd/);
    await signed({ action: "homepage.publish", input: { homepageScope: scopes.bd, expectedRevision: 1 } });
    assert.equal(homeInvalidations, 1);
    assert.equal(section(await homepageReadPayload(bd, { at: before }), panel.key), undefined);
    assert.deepEqual(section(await homepageReadPayload(bd, { at: starts }), panel.key)?.benefits, [benefit]);
    assert.equal(section(await homepageReadPayload(bd, { at: ends }), panel.key), undefined);
    assert.equal(section(await homepageReadPayload(us, { at: starts }), panel.key), undefined);
    await signed({ action: "homepage.inherit", input: { homepageScope: scopes.bd, expectedRevision: 2 } });
    assert.equal(homeInvalidations, 2);
    assert.equal(section(await homepageReadPayload(bd, { at: starts }), panel.key), undefined);
  } finally {
    await db.homepageContent.updateMany({ where: { key: { in: keys } }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: { in: keys } } });
    await db.homepageContent.deleteMany({ where: { key: { in: keys } } });
    await db.auditEvent.deleteMany({ where: { actorId: owner.userId, target: { in: keys } } });
  }
});
