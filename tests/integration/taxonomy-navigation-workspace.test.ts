import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { listConnectedCatalog } from "../../src/lib/catalog/connected-listing.ts";
import { connectedCollectionDetail } from "../../src/lib/catalog/connected-navigation.ts";
import { readMarketMenu } from "../../src/lib/catalog/navigation.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveCatalogCollection, saveCollectionMarketPublication, saveMarketMenu, setCuratedCollectionProducts } from "../../src/lib/staff/navigation.ts";
import { loadCollectionWorkspace, loadNavigationWorkspace, searchCollectionProducts } from "../../src/lib/staff/navigation-workspace.ts";
import { saveCategoryTranslation } from "../../src/lib/staff/taxonomy.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("manual collections retain order and market publication, and an independent localized menu preserves offer eligibility", async () => {
  const key = `menu7-${randomUUID().slice(0, 12)}`;
  const rootId = `${key}-root`;
  const owner = `${key}-owner`;
  const delegate = `${key}-bd`;
  const collectionId = `${key}-collection`;
  const productIds = [`${key}-first`, `${key}-second`];
  const sku = (index: number) => `${key.toUpperCase()}-${index}`;
  const previousMarketConfig = process.env.GRIIP_MARKET_CONFIGURATION;
  const bd = { marketId: "bd", locale: "en-BD" } as const;
  const us = { marketId: "us", locale: "en-US" } as const;
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ bd: { languages: ["en-BD", "bn-BD"] } });
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid`, name: "Collection owner",
      staff: { create: { role: "OWNER" } } } });
    await db.user.create({ data: { id: delegate, email: `${delegate}@example.invalid`, name: "BD merchandiser",
      staff: { create: { role: "PACKER", marketGrants: { create: { marketId: "bd", merchandising: true } } } } } });
    await db.department.create({ data: { id: rootId, slug: rootId, kind: "DEPARTMENT", name: "Catalog test", shortName: "Test",
      description: "", imageSrc: "/catalog/headphones-taupe.webp", imageAlt: "Catalog test device", position: 0 } });
    const localizedSlug = `bn-${rootId}`;
    await saveCategoryTranslation(owner, { id: rootId, revision: 0, locale: "bn-BD", translation: {
      name: "ভ্রমণ", shortName: "ভ্রমণ", description: "", slug: localizedSlug,
    } });
    for (const [index, id] of productIds.entries()) {
      await db.product.create({ data: { id, slug: id, departmentId: rootId, name: `Collection product ${index}`, publication: "ACTIVE",
        description: "", keywords: [], specifications: [], addedOn: new Date(0), position: index, variants: { create: {
          id: `v-${id}`, sku: sku(index), position: 0, label: "Standard", options: {},
          offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 100 + index } }, inventory: { create: { available: 4 } },
        } } } });
    }
    const definition = { id: collectionId, slug: collectionId, name: "Travel collection", description: "", selection: "CURATED",
      position: 80, expectedRevision: null, image: null };
    await assert.rejects(saveCatalogCollection(delegate, definition), /permission/);
    const created = await saveCatalogCollection(owner, definition);
    assert.equal(await connectedCollectionDetail(collectionId, bd, db), null);
    await assert.rejects(saveCollectionMarketPublication(delegate, {
      collectionId, marketId: "bd", expectedRevision: created.revision, published: true,
    }), /visible offer/);

    const initial = await setCuratedCollectionProducts(owner, {
      collectionId, expectedRevision: created.revision, expectedProductIds: [], productIds,
    });
    const ordered = [...productIds].reverse();
    const assigned = await setCuratedCollectionProducts(owner, {
      collectionId, expectedRevision: initial.revision, expectedProductIds: productIds, productIds: ordered,
    });
    await assert.rejects(setCuratedCollectionProducts(owner, {
      collectionId, expectedProductIds: productIds, productIds,
    }), /saved product order/);
    const choices = await searchCollectionProducts(owner, { collectionId, marketId: "bd", q: sku(1), page: "1" });
    assert.equal(choices.count, 1);
    assert.equal(choices.products[0].id, productIds[1]);
    await assert.rejects(searchCollectionProducts(delegate, { collectionId, marketId: "bd" }), /permission/);
    await assert.rejects(saveCollectionMarketPublication(delegate, {
      collectionId, marketId: "us", expectedRevision: assigned.revision, published: true,
    }), /permission/);
    await assert.rejects(saveCollectionMarketPublication(owner, {
      collectionId, marketId: "us", expectedRevision: assigned.revision, published: true,
    }), /visible offer/);
    const published = await saveCollectionMarketPublication(delegate, {
      collectionId, marketId: "bd", expectedRevision: assigned.revision, published: true,
    });
    assert.equal((await connectedCollectionDetail(collectionId, bd, db))?.collection.id, collectionId);
    assert.equal(await connectedCollectionDetail(collectionId, us, db), null);
    assert.deepEqual((await listConnectedCatalog(new URLSearchParams({ collection: collectionId }), bd, db)).items.map(item => item.id), ordered);
    assert.deepEqual((await catalog.listProducts({ collectionId, marketId: "bd" })).map(product => product.id), ordered);
    assert.equal(await catalog.getCollection(collectionId, "us"), null);
    const ownerView = await loadCollectionWorkspace(owner, "bd", collectionId);
    assert.deepEqual(ownerView.current?.products.map(product => product.id), ordered);
    assert.equal((await loadCollectionWorkspace(delegate, "bd", collectionId)).current?.products.length, 0);

    const collectionItem = { type: "collection", collectionId };
    await assert.rejects(saveMarketMenu(delegate, { marketId: "us", key, expectedRevision: null, items: [] }), /permission/);
    await assert.rejects(saveMarketMenu(delegate, { marketId: "bd", key, locale: "fr-FR", expectedRevision: null, items: [] }), /configured/);
    const base = await saveMarketMenu(delegate, { marketId: "bd", key, expectedRevision: null, items: [collectionItem] });
    const localizedPreview = await loadNavigationWorkspace(delegate, "bd", key, "bn-BD");
    assert.equal(localizedPreview.inheritsMenu, true);
    assert.deepEqual(localizedPreview.history, []);
    const categoryTarget = localizedPreview.categories.find(row => row.id === rootId);
    assert.equal(categoryTarget?.label, "ভ্রমণ");
    const previewUrl = new URL(categoryTarget!.href, "http://127.0.0.1");
    assert.match(previewUrl.pathname, new RegExp(`/departments/${localizedSlug}$`));
    assert.equal(previewUrl.searchParams.get("market"), "bd");
    assert.equal(previewUrl.searchParams.get("lang"), "bn-BD");
    const localized = await saveMarketMenu(delegate, { marketId: "bd", key, locale: "bn-BD", expectedRevision: null,
      items: [{ type: "page", page: "SHOP", label: "বাংলা দোকান" }, { ...collectionItem, visible: false }] });
    await saveMarketMenu(owner, { marketId: "us", key, expectedRevision: null, items: [{ type: "page", page: "SHOP" }] });
    const localizedHistory = (await loadNavigationWorkspace(delegate, "bd", key, "bn-BD")).history;
    assert.deepEqual(localizedHistory.map(({ createdAt, ...event }) => {
      assert.ok(Number.isFinite(Date.parse(createdAt)));
      return event;
    }), [{ actor: "BD merchandiser", summary: "Menu saved", scope: "bd", revision: localized.revision }]);
    assert.deepEqual((await loadNavigationWorkspace(owner, "us", key)).history.map(row => row.actor), ["Collection owner"]);
    await assert.rejects(loadNavigationWorkspace(delegate, "us", key), /permission/);
    assert.deepEqual((await readMarketMenu("bd", key, "bn-BD", db))?.items.map(({ label }) => label), ["বাংলা দোকান"]);
    assert.deepEqual((await readMarketMenu("bd", key, "en-BD", db))?.items.map(({ label }) => label), ["Travel collection"]);
    const hiddenMenu = await saveMarketMenu(delegate, { marketId: "bd", key, expectedRevision: base.revision,
      items: [{ ...collectionItem, visible: false }] });
    let menuRevision = hiddenMenu.revision;
    for (let index = 0; index < 15; index++) {
      const saved = await saveMarketMenu(delegate, { marketId: "bd", key, expectedRevision: menuRevision,
        items: [{ ...collectionItem, visible: false }] });
      menuRevision = saved.revision;
    }
    const defaultHistory = (await loadNavigationWorkspace(delegate, "bd", key)).history;
    assert.deepEqual(defaultHistory.map(row => row.revision), Array.from({ length: 15 }, (_, index) => menuRevision - index));
    assert.deepEqual((await readMarketMenu("bd", key, "en-BD", db))?.items, []);
    assert.equal((await catalog.getProduct(productIds[0], "bd"))?.variants[0]?.offer?.stock, 4);
    assert.ok(await connectedCollectionDetail(collectionId, bd, db));

    const hidden = await saveCollectionMarketPublication(delegate, {
      collectionId, marketId: "bd", expectedRevision: published.revision, published: false,
    });
    assert.equal(await connectedCollectionDetail(collectionId, bd, db), null);
    assert.deepEqual(await catalog.listProducts({ collectionId, marketId: "bd" }), []);
    assert.equal((await catalog.getProduct(productIds[0], "bd"))?.variants[0]?.offer?.stock, 4);
    await db.marketOffer.create({ data: { variantId: `v-${productIds[0]}`, marketId: "us", currency: "USD", amountMinor: 100 } });
    const usa = await saveCollectionMarketPublication(owner, {
      collectionId, marketId: "us", expectedRevision: hidden.revision, published: true,
    });
    const publicationEvents = (await loadCollectionWorkspace(delegate, "bd", collectionId)).current?.history;
    assert.deepEqual(publicationEvents?.map(({ createdAt, ...event }) => {
      assert.ok(Number.isFinite(Date.parse(createdAt)));
      return event;
    }), [
      { summary: "Collection hidden", actor: "BD merchandiser", scope: "bd", revision: hidden.revision },
      { summary: "Collection published", actor: "BD merchandiser", scope: "bd", revision: published.revision },
    ]);
    const ownerBd = (await loadCollectionWorkspace(owner, "bd", collectionId)).current?.history ?? [];
    assert.deepEqual(ownerBd.filter(event => event.scope === "shared").map(event => event.summary),
      ["Collection products saved", "Collection products saved", "Collection created"]);
    assert.equal(ownerBd.some(event => event.scope === "us"), false);
    const ownerUs = (await loadCollectionWorkspace(owner, "us", collectionId)).current?.history ?? [];
    assert.deepEqual(ownerUs.filter(event => event.scope !== "shared").map(event => event.revision), [usa.revision]);
    await assert.rejects(loadCollectionWorkspace(delegate, "us", collectionId), /permission/);
    const audited = await db.auditEvent.findMany({ where: { actorId: delegate }, select: { action: true } });
    assert.ok(audited.filter(event => event.action === "TAXONOMY_SAVED").length >= 5);
  } finally {
    if (previousMarketConfig === undefined) delete process.env.GRIIP_MARKET_CONFIGURATION;
    else process.env.GRIIP_MARKET_CONFIGURATION = previousMarketConfig;
    await db.marketMenu.deleteMany({ where: { key } });
    await db.collection.deleteMany({ where: { id: collectionId } });
    await db.marketOffer.deleteMany({ where: { variantId: { in: productIds.map(id => `v-${id}`) } } });
    await db.inventory.deleteMany({ where: { variantId: { in: productIds.map(id => `v-${id}`) } } });
    await db.variant.deleteMany({ where: { productId: { in: productIds } } });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
    await db.departmentTranslation.deleteMany({ where: { departmentId: rootId } });
    await db.departmentSlugAlias.deleteMany({ where: { departmentId: rootId } });
    await db.department.deleteMany({ where: { id: rootId } });
    await db.auditEvent.deleteMany({ where: { actorId: { in: [owner, delegate] } } });
    await db.user.deleteMany({ where: { id: { in: [owner, delegate] } } });
  }
});
