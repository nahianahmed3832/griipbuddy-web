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
    await db.department.create({ data: { id: rootId, slug: rootId, name: "Catalog test", shortName: "Test",
      description: "", imageSrc: "/catalog/headphones-taupe.webp", imageAlt: "Catalog test device", position: 0 } });
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

    const ordered = [...productIds].reverse();
    const assigned = await setCuratedCollectionProducts(owner, {
      collectionId, expectedRevision: created.revision, expectedProductIds: [], productIds: ordered,
    });
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
    assert.equal((await loadNavigationWorkspace(delegate, "bd", key, "bn-BD")).inheritsMenu, true);
    await saveMarketMenu(delegate, { marketId: "bd", key, locale: "bn-BD", expectedRevision: null,
      items: [{ type: "page", page: "SHOP", label: "বাংলা দোকান" }, { ...collectionItem, visible: false }] });
    assert.deepEqual((await readMarketMenu("bd", key, "bn-BD", db))?.items.map(({ label }) => label), ["বাংলা দোকান"]);
    assert.deepEqual((await readMarketMenu("bd", key, "en-BD", db))?.items.map(({ label }) => label), ["Travel collection"]);
    await saveMarketMenu(delegate, { marketId: "bd", key, expectedRevision: base.revision,
      items: [{ ...collectionItem, visible: false }] });
    assert.deepEqual((await readMarketMenu("bd", key, "en-BD", db))?.items, []);
    assert.equal((await catalog.getProduct(productIds[0], "bd"))?.variants[0]?.offer?.stock, 4);
    assert.ok(await connectedCollectionDetail(collectionId, bd, db));

    await saveCollectionMarketPublication(delegate, {
      collectionId, marketId: "bd", expectedRevision: published.revision, published: false,
    });
    assert.equal(await connectedCollectionDetail(collectionId, bd, db), null);
    assert.deepEqual(await catalog.listProducts({ collectionId, marketId: "bd" }), []);
    assert.equal((await catalog.getProduct(productIds[0], "bd"))?.variants[0]?.offer?.stock, 4);
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
    await db.department.deleteMany({ where: { id: rootId } });
    await db.auditEvent.deleteMany({ where: { actorId: { in: [owner, delegate] } } });
    await db.user.deleteMany({ where: { id: { in: [owner, delegate] } } });
  }
});
