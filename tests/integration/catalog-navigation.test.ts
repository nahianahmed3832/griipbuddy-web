import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import "../../scripts/load-env.ts";
import { readMarketMenu } from "../../src/lib/catalog/navigation.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveMarketMenu, setCuratedCollectionProducts } from "../../src/lib/staff/navigation.ts";
import { archiveCategory } from "../../src/lib/staff/taxonomy.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const prefix = `stage2-nav-${randomUUID()}`;
const owner = `${prefix}-owner`;
const packer = `${prefix}-packer`;
const image = { imageSrc: "/editorial/hero.webp", imageAlt: "Example" };

before(async () => {
  await db.user.create({ data: { id: owner, name: "Taxonomy owner", email: `${owner}@example.test`, staff: { create: { role: "OWNER" } } } });
  await db.user.create({ data: { id: packer, name: "Packing staff", email: `${packer}@example.test`, staff: { create: { role: "PACKER" } } } });
});

after(async () => {
  await db.auditEvent.deleteMany({ where: { actorId: { in: [owner, packer] } } });
  await db.user.deleteMany({ where: { id: { in: [owner, packer] } } });
  await db.$disconnect();
});

test("market menus keep taxonomy stable, resolve locale separately and hide only navigation targets", async () => {
  const rootId = `${prefix}-tech`;
  const categoryId = `${prefix}-cases`;
  const leafId = `${prefix}-clear`;
  const collectionId = `${prefix}-trip`;
  const productId = `${prefix}-case`;
  const key = prefix;
  const items = [
    { type: "category", categoryId },
    { type: "collection", collectionId },
    { type: "page", page: "SHOP" },
  ];
  const input = { marketId: "bd", key, expectedRevision: null, items };
  const category = { name: "Technology", shortName: "Tech", description: "", position: 1, ...image };
  try {
    await db.department.create({ data: { ...category, id: rootId, slug: rootId, kind: "DEPARTMENT",
      marketPresentations: { create: { marketId: "bd", visibleInNavigation: false } },
    } });
    await db.department.create({ data: { ...category, id: categoryId, slug: categoryId, name: "Phone cases", shortName: "Cases",
      kind: "CATEGORY", parentId: rootId,
      translations: { create: { locale: "es-US", name: "Fundas para móviles", shortName: "Fundas", description: "Protección", slug: "fundas" } },
    } });
    await db.department.create({ data: { ...category, id: leafId, slug: leafId, name: "Clear cases", shortName: "Clear",
      kind: "SUBCATEGORY", parentId: categoryId,
    } });
    await db.product.create({ data: { id: productId, slug: productId, departmentId: leafId, name: "Clear case", description: "",
      specifications: [], keywords: [], addedOn: new Date(), position: 0, publication: "ACTIVE",
      variants: { create: { id: `v-${productId}`, sku: productId, label: "Standard", position: 0, options: {},
        offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 100 } }, inventory: { create: { available: 5 } },
      } },
    } });
    await db.collection.create({ data: { id: collectionId, slug: collectionId, position: 10, name: "Travel picks", description: "" } });

    await assert.rejects(saveMarketMenu(packer, input), /permission/);
    await assert.rejects(saveMarketMenu(owner, { ...input, items: [{ type: "page", page: "https://example.test" }] }), /page/);
    await assert.rejects(saveMarketMenu(owner, { ...input, items: [{ type: "category", categoryId: "absent-stage2-category" }] }), /does not exist/);
    const bd = await saveMarketMenu(owner, input);
    const us = await saveMarketMenu(owner, { ...input, marketId: "us", items: [items[2], items[0]] });
    assert.notEqual(bd.id, us.id);

    const bdMenu = await readMarketMenu("bd", key, "es-US", db);
    assert.deepEqual(bdMenu?.items.map(item => [item.position, item.label]), [[1, "Travel picks"], [2, "Tienda"]]);
    const product = await catalog.getProduct(productId, "bd");
    assert.equal(product?.variants[0]?.offer?.stock, 5);
    const usMenu = await readMarketMenu("us", key, "es-US", db);
    assert.deepEqual(usMenu?.items.map(item => [item.label, item.href]), [
      ["Tienda", "/shop"], ["Fundas", "/departments/fundas"],
    ]);
    assert.equal((await readMarketMenu("us", key, "en-US", db))?.items[1].label, "Cases");
    assert.equal((await catalog.getDepartment(categoryId))?.parentId, rootId);
    await assert.rejects(db.marketMenuItem.create({
      data: { menuId: bd.id, position: 20, departmentId: categoryId, page: "SHOP" },
    }), /constraint/i);

    const updates = await Promise.allSettled([
      saveMarketMenu(owner, { ...input, expectedRevision: bd.revision, items: [items[0]] }),
      saveMarketMenu(owner, { ...input, expectedRevision: bd.revision, items: [items[2]] }),
    ]);
    assert.equal(updates.filter(result => result.status === "fulfilled").length, 1);
    const rejection = updates.find(result => result.status === "rejected");
    assert.match(String(rejection?.reason), /changed/);
    assert.equal((await db.marketMenu.findUniqueOrThrow({ where: { id: bd.id } })).revision, bd.revision + 1);

    await db.product.update({ where: { id: productId }, data: { publication: "DRAFT" } });
    await archiveCategory(owner, { id: leafId, revision: 0 });
    await archiveCategory(owner, { id: categoryId, revision: 0 });
    assert.deepEqual((await readMarketMenu("us", key, "es-US", db))?.items.map(item => item.href), ["/shop"]);
  } finally {
    await db.marketMenu.deleteMany({ where: { key } });
    await db.collection.deleteMany({ where: { id: collectionId } });
    await db.marketOffer.deleteMany({ where: { variantId: `v-${productId}` } });
    await db.inventory.deleteMany({ where: { variantId: `v-${productId}` } });
    await db.variant.deleteMany({ where: { productId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.departmentTranslation.deleteMany({ where: { departmentId: categoryId } });
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: rootId } });
    await db.department.deleteMany({ where: { id: leafId } });
    await db.department.deleteMany({ where: { id: categoryId } });
    await db.department.deleteMany({ where: { id: rootId } });
  }
});

test("curated collection membership uses existing joins without changing product or rule collection eligibility", async () => {
  const categoryId = `${prefix}-legacy`;
  const collectionId = `${prefix}-curated`;
  const ruleId = `${prefix}-new`;
  const liveId = `${prefix}-live`;
  const draftId = `${prefix}-draft`;
  const productIds = [liveId, draftId];
  const published = { departmentId: categoryId, name: "Example", description: "", specifications: [], keywords: [],
    addedOn: new Date(), position: 0 };
  const input = { collectionId, expectedProductIds: [], productIds };
  try {
    await db.department.create({ data: { id: categoryId, slug: categoryId, name: "Legacy category", shortName: "Legacy",
      description: "", position: 0, ...image } });
    await db.collection.createMany({ data: [
      { id: collectionId, slug: collectionId, name: "Curated", description: "", position: 0 },
      { id: ruleId, slug: ruleId, name: "New arrivals", description: "", position: 1, selection: "NEW" },
    ] });
    await db.product.create({ data: { ...published, id: liveId, slug: liveId, publication: "ACTIVE", newArrival: true,
      variants: { create: { id: `v-${liveId}`, sku: liveId, label: "Standard", position: 0, options: {},
        offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 100 } }, inventory: { create: { available: 5 } },
      } },
    } });
    await db.product.create({ data: { ...published, id: draftId, slug: draftId } });

    await assert.rejects(setCuratedCollectionProducts(packer, input), /permission/);
    await assert.rejects(setCuratedCollectionProducts(owner, { ...input, productIds: [liveId, liveId] }), /once/);
    await assert.rejects(setCuratedCollectionProducts(owner, { ...input, collectionId: ruleId }), /Only curated/);
    await assert.rejects(setCuratedCollectionProducts(owner, { ...input, productIds: ["missing-stage2-product"] }), /does not exist/);
    await setCuratedCollectionProducts(owner, input);
    await assert.rejects(setCuratedCollectionProducts(owner, input), /changed/);
    assert.deepEqual((await catalog.listProducts({ marketId: "bd", collectionId })).map(product => product.id), [liveId]);
    assert.deepEqual(await catalog.listProducts({ marketId: "us", collectionId }), []);
    assert.deepEqual((await catalog.listProducts({ marketId: "bd", collectionId: ruleId, productIds })).map(product => product.id), [liveId]);
    assert.equal(await db.collectionProduct.count({ where: { collectionId: ruleId } }), 0);

    await setCuratedCollectionProducts(owner, { collectionId, expectedProductIds: [draftId, liveId], productIds: [draftId] });
    assert.deepEqual(await catalog.listProducts({ marketId: "bd", collectionId }), []);
    const product = await db.product.findUniqueOrThrow({ where: { id: liveId } });
    assert.equal(product.departmentId, categoryId);
    assert.equal(product.publication, "ACTIVE");
    assert.equal(product.revision, 2);
    const draft = await db.product.findUniqueOrThrow({ where: { id: draftId } });
    assert.equal(draft.publication, "DRAFT");
    assert.equal(draft.revision, 1);
    assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: `v-${liveId}` } })).available, 5);
  } finally {
    await db.collection.deleteMany({ where: { id: { in: [collectionId, ruleId] } } });
    await db.marketOffer.deleteMany({ where: { variantId: `v-${liveId}` } });
    await db.inventory.deleteMany({ where: { variantId: `v-${liveId}` } });
    await db.variant.deleteMany({ where: { productId: liveId } });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
    await db.department.deleteMany({ where: { id: categoryId } });
  }
});
