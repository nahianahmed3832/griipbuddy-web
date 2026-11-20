import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import sharp from "sharp";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { defaultHomepage, type HomepageSection } from "../../src/lib/catalog/homepage-contract.ts";
import { isPublishedHomepageMedia } from "../../src/lib/catalog/homepage-content.ts";
import { homepageReadPayload } from "../../src/lib/catalog/homepage-layout.ts";
import { handleMainAdminCatalog } from "../../src/lib/catalog/main-admin-api.ts";
import { marketConfiguration } from "../../src/lib/market-config.ts";
import { publishHomepage, saveHomepageDraft } from "../../src/lib/staff/homepage.ts";
import { storeHomepageImage } from "../../src/lib/staff/homepage-media.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("signed tile publishing resolves ordered live catalog references and confines draft media to its upload scope", async () => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const key = "global:default";
  assert.equal(await db.homepageContent.count({ where: { key } }), 0);
  const usPolicy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" } });
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ us: {
    delivery: { coverage: "checkout-policy" },
    payments: [{ method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true }],
    pricing: { ...marketConfiguration("us").pricing, taxTreatment: "MERCHANDISE_RATE" },
  } });
  const bd = marketConfiguration("bd");
  const us = marketConfiguration("us");
  const legacyId = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("hex");
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED = "1";
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN = "http://127.0.0.1:4379";
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_SECRET = secret;
  process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS = JSON.stringify({ [legacyId]: owner.userId });
  let invalidations = 0;
  const signed = (operation: object) => {
    const body = JSON.stringify({ legacyId, central: true, marketId: bd.id, issuedAt: Date.now(), nonce: randomUUID(), request: operation });
    const signature = createHmac("sha256", secret).update("griip-main-admin-catalog-v1\n").update(body).digest("hex");
    return handleMainAdminCatalog(new Request("http://127.0.0.1:3127/api/internal/main-admin-catalog", {
      method: "POST", body, headers: { "content-type": "application/json", "x-griip-admin-channel": "homepage", "x-griip-catalog-signature": signature },
    }), undefined, () => { invalidations++; });
  };
  const read = async <T>(operation: object, status = 200) => {
    const response = await signed(operation);
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value.data as T;
  };
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3,
    background: `#${randomUUID().slice(0, 6)}` } }).png().toBuffer();
  const { src } = await storeHomepageImage(owner.userId, { marketId: bd.id, locale: bd.locale }, bytes, "image/png");
  const scope = { homepageScope: key };
  const editor = { editor: "main-admin" as const };
  const section: HomepageSection = {
    key: "editorial-fixture", type: "TILES", title: "Workshop favorites", position: 2, tileLayout: "DISCOVERY",
    startsLocal: "2027-02-11T09:00",
    tiles: [
      { key: "useful-tech", kind: "COLLECTION", referenceId: "c-tech", title: "Desk upgrades", ctaLabel: "Browse tech" },
      { key: "phone-stand", kind: "PRODUCT", referenceId: "p-stand" },
      { key: "electronics", kind: "CATEGORY", referenceId: "d-electronics", focalPoint: { x: 41, y: 59 },
        mobileImage: { src, alt: "Studio electronics crop" }, mobileFocalPoint: { x: 30, y: 72 } },
    ],
  };
  const body = { sections: [...defaultHomepage.sections, section], hiddenSections: [] };
  const at = new Date("2027-02-11T16:00:00Z");
  const before = new Date("2027-02-10T16:00:00Z");
  const panel = (payload: Awaited<ReturnType<typeof homepageReadPayload>>) => payload.sections.find(row => row.id === section.key);
  try {
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
      enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 500, taxLabel: "Fixture tax",
    } });
    await db.deliveryZone.create({ data: {
      marketId: "us", district: "wa", districtLabel: "Washington", method: "tile-test", label: "Fixture delivery", chargeMinor: 350,
    } });
    await assert.rejects(saveHomepageDraft(owner.userId, {}, 0, body), /main GriipBuddy admin/);
    await assert.rejects(saveHomepageDraft(owner.userId, {}, 0, { ...body,
      sections: [...defaultHomepage.sections, { ...section, tiles: [{ key: "invalid", kind: "CATEGORY", referenceId: "missing-category" }] }],
    }, undefined, editor), /current catalog category/);
    await read({ action: "homepage.save", input: { ...scope, expectedRevision: 0, content: body } });
    type Reference = { id: string };
    const saved = await read<{ references: Record<"categories" | "collections" | "products" | "media", Reference[]> }>({ read: "homepage", ...scope });
    assert.ok(saved.references.categories.some(item => item.id === "d-electronics"));
    assert.ok(saved.references.collections.some(item => item.id === "c-tech"));
    assert.ok(saved.references.products.some(item => item.id === "p-stand"));
    assert.ok(saved.references.media.some(item => item.id === src));
    assert.equal(panel(await homepageReadPayload(bd, { at })), undefined);
    assert.equal(await isPublishedHomepageMedia(src, bd, at), false);
    await read({ read: "homepage-asset", id: src });

    const preview = await read<Awaited<ReturnType<typeof homepageReadPayload>>>({
      read: "homepage-preview", ...scope, marketId: bd.id, locale: bd.locale, previewAt: "2027-02-11T10:00",
    });
    const tiles = panel(preview)?.tiles;
    assert.equal(panel(preview)?.tileLayout, "DISCOVERY");
    assert.deepEqual(tiles?.map(tile => tile.id), ["useful-tech", "phone-stand", "electronics"]);
    assert.equal(tiles?.[0].title, "Desk upgrades");
    assert.equal(tiles?.[0].ctaLabel, "Browse tech");
    assert.match(tiles?.[0].href ?? "", /\/collections\/useful-tech\?market=bd&lang=en-BD$/);
    assert.equal(tiles?.[1].product?.amountMinor, 85_000);
    assert.equal(new URL(tiles![1].href, "http://127.0.0.1").searchParams.get("variant"), tiles?.[1].product?.variantId);
    assert.deepEqual(tiles?.[2].focalPoint, { x: 41, y: 59 });
    assert.deepEqual(tiles?.[2].mobileFocalPoint, { x: 30, y: 72 });
    assert.ok(tiles?.[2].mobileImage?.src.endsWith(`${src}?market=bd&lang=en-BD`));

    await assert.rejects(publishHomepage(owner.userId, {}, 1), /main GriipBuddy admin/);
    const first = await read<{ releaseId: string }>({ action: "homepage.publish", input: { ...scope, expectedRevision: 1 } });
    assert.equal(invalidations, 1);
    assert.equal(panel(await homepageReadPayload(bd, { at: before })), undefined);
    assert.deepEqual(panel(await homepageReadPayload(bd, { at }))?.tiles, tiles);
    assert.equal(await isPublishedHomepageMedia(src, bd, at), true);
    assert.equal(await isPublishedHomepageMedia(src, us, at), false);
    const usPayload = await homepageReadPayload(us, { at });
    const usTiles = panel(usPayload)?.tiles ?? [];
    assert.equal(usPayload.currency, "USD");
    assert.deepEqual(usTiles.map(tile => tile.id), ["useful-tech", "phone-stand", "electronics"]);
    assert.ok(usTiles.every(tile => !tile.mobileImage?.src.includes(src)));
    assert.equal(usTiles[1].product?.amountMinor, 1_400);

    await read({ action: "homepage.save", input: { ...scope, expectedRevision: 2,
      content: { ...body, sections: [...defaultHomepage.sections, { ...section, enabled: false }] } } });
    await read({ action: "homepage.publish", input: { ...scope, expectedRevision: 3 } });
    assert.equal(panel(await homepageReadPayload(bd, { at })), undefined);
    assert.equal(await isPublishedHomepageMedia(src, bd, at), false);
    await read({ action: "homepage.restore", input: { ...scope, expectedRevision: 4, releaseId: first.releaseId } });
    assert.deepEqual(panel(await homepageReadPayload(bd, { at }))?.tiles, tiles);
    assert.equal(invalidations, 3);
  } finally {
    await db.deliveryZone.deleteMany({ where: { marketId: "us", district: "wa", method: "tile-test" } });
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
      enabled: usPolicy.enabled, codEnabled: usPolicy.codEnabled, taxTreatment: usPolicy.taxTreatment,
      taxBasisPoints: usPolicy.taxBasisPoints, taxLabel: usPolicy.taxLabel,
    } });
    await db.homepageContent.updateMany({ where: { key }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: key } });
    await db.homepageContent.deleteMany({ where: { key } });
    await db.auditEvent.deleteMany({ where: { actorId: owner.userId, target: { in: [key, `homepage-media:${src.slice(7)}`] } } });
    await db.catalogMedia.deleteMany({ where: { id: src.slice(7) } });
  }
});
