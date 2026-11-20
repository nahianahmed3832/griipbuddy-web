import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { listCategoryPresentation, resolveCategorySlug } from "../../src/lib/catalog/category-presentation.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import {
  archiveCategory, reorderCategories, saveCategory, saveCategoryMarketPresentation, saveCategoryTranslation, saveTaxonomy,
} from "../../src/lib/staff/taxonomy.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

const image = { src: "/catalog/phone-stand.webp", alt: "Category fixture" };

async function fixture(t: TestContext) {
  const prefix = "test-taxonomy-" + randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const packerId = randomUUID();
  const departmentIds: string[] = [];
  const belongsToTest = { startsWith: prefix };
  t.after(async () => {
    await db.productSecondaryCategory.deleteMany({ where: { productId: belongsToTest } });
    await db.inventory.deleteMany({ where: { variantId: belongsToTest } });
    await db.variant.deleteMany({ where: { productId: belongsToTest } });
    await db.product.deleteMany({ where: { id: belongsToTest } });
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: belongsToTest } });
    await db.departmentTranslation.deleteMany({ where: { departmentId: belongsToTest } });
    await db.departmentSlugAlias.deleteMany({ where: { departmentId: belongsToTest } });
    for (const id of departmentIds.reverse()) await db.department.deleteMany({ where: { id } });
    await db.auditEvent.deleteMany({ where: { actorId: { in: [ownerId, packerId] } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, packerId] } } });
  });
  await db.user.create({ data: { id: ownerId, name: "Taxonomy Owner", email: ownerId + "@example.test",
    staff: { create: { role: "OWNER" } } } });
  await db.user.create({ data: { id: packerId, name: "Taxonomy Packer", email: packerId + "@example.test",
    staff: { create: { role: "PACKER" } } } });

  function input(key: string, kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY", parentId: string | null = null,
    state: "DRAFT" | "ACTIVE" = "ACTIVE") {
    const id = prefix + "-" + key;
    return {
      id, slug: id, name: "Category " + key, shortName: "Category " + key, description: "", image,
      kind, parentId, state, position: 0, revision: null,
    };
  }

  async function create(value: ReturnType<typeof input>) {
    const row = await saveCategory(ownerId, value);
    departmentIds.push(row.id);
    return row;
  }

  async function legacy(value: ReturnType<typeof input>, existingId: string | null = null) {
    await saveTaxonomy(ownerId, { ...value, kind: "department" }, existingId);
    if (existingId === null) departmentIds.push(value.id);
  }
  return { ownerId, packerId, prefix, input, create, legacy };
}

test("typed category moves serialize, retain catalog SKU identity, and reject invalid parents", async (t) => {
  const { ownerId, packerId, prefix, input, create } = await fixture(t);
  await assert.rejects(saveCategory(packerId, input("denied", "DEPARTMENT")), /permission/);
  const root = await create(input("tech", "DEPARTMENT"));
  const draftRoot = await create(input("draft", "DEPARTMENT", null, "DRAFT"));
  const left = await create(input("cases", "CATEGORY", root.id));
  const right = await create(input("accessories", "CATEGORY", root.id));
  const secondary = await create(input("travel", "SUBCATEGORY", right.id));
  const fields = input("protective", "SUBCATEGORY", left.id);
  const leaf = await create(fields);
  await assert.rejects(saveCategory(ownerId, input("too-deep", "SUBCATEGORY", leaf.id)), /valid parent level/);
  await assert.rejects(saveCategory(ownerId, input("wrong-root", "DEPARTMENT", root.id)), /roots/);
  await assert.rejects(saveCategory(ownerId, input("under-draft", "CATEGORY", draftRoot.id)), /active ancestors/);
  await assert.rejects(saveCategory(ownerId, { ...fields, parentId: leaf.id, revision: leaf.revision }), /under itself/);
  await assert.rejects(saveCategory(ownerId, { ...fields, kind: "CATEGORY", parentId: root.id, revision: leaf.revision }), /level cannot change/);

  const productId = prefix + "-product";
  const variantId = prefix + "-variant";
  await db.product.create({ data: {
    id: productId, slug: productId, name: "Protective case", departmentId: leaf.id, description: "", specifications: [],
    keywords: [], position: 0, addedOn: new Date(), publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId.toUpperCase(), options: {}, label: "Standard", position: 0,
      inventory: { create: { available: 7 } } } },
  } });
  await db.productSecondaryCategory.create({ data: { productId, departmentId: secondary.id, primaryDepartmentId: leaf.id } });
  await assert.rejects(archiveCategory(ownerId, { id: leaf.id, revision: leaf.revision }), /reassign or retire/i);
  await assert.rejects(archiveCategory(ownerId, { id: secondary.id, revision: secondary.revision }), /reassign or retire/i);
  await assert.rejects(archiveCategory(ownerId, { id: left.id, revision: left.revision }), /reassign or retire/i);
  const proposals = [1, 2].map((position) =>
    saveCategory(ownerId, { ...fields, parentId: right.id, position, revision: leaf.revision }));
  const attempts = await Promise.allSettled(proposals);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  const conflict = attempts.find(({ status }) => status === "rejected");
  assert.ok(conflict?.status === "rejected");
  assert.match(String(conflict.reason), /category changed/i);
  const moved = await db.department.findUniqueOrThrow({ where: { id: leaf.id } });
  assert.equal(moved.parentId, right.id);
  assert.equal(moved.slug, leaf.slug);
  const product = await db.product.findUniqueOrThrow({
    where: { id: productId }, include: { variants: { include: { inventory: true } }, secondaryCategories: true },
  });
  assert.equal(product.departmentId, leaf.id);
  assert.deepEqual(product.secondaryCategories.map(({ departmentId }) => departmentId), [secondary.id]);
  assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0]?.id, variantId);
  assert.equal(product.variants[0]?.inventory?.available, 7);
});

test("legacy taxonomy still writes unclassified rows and rejects a circular move", async (t) => {
  const { ownerId, input, create, legacy } = await fixture(t);
  const legacyRoot = input("legacy-root", "DEPARTMENT");
  const legacyChild = input("legacy-child", "CATEGORY", legacyRoot.id);
  await legacy(legacyRoot);
  await legacy(legacyChild);
  await assert.rejects(legacy({ ...legacyRoot, parentId: legacyChild.id }, legacyRoot.id), /descendants/);
  const typed = await create(input("typed-root", "DEPARTMENT"));
  await assert.rejects(legacy({ ...legacyChild, parentId: typed.id }, legacyChild.id), /valid parent level/);
  await assert.rejects(saveTaxonomy(ownerId, { ...input("typed-root", "DEPARTMENT"), kind: "department" }, typed.id), /typed category/);
  const row = await db.department.findUniqueOrThrow({ where: { id: legacyChild.id } });
  assert.equal(row.parentId, legacyRoot.id);
  assert.equal(row.kind, null);
  assert.equal(row.state, "ACTIVE");
});

test("reorder checks the entire live sibling set and archive retains the stable row", async (t) => {
  const { ownerId, input, create } = await fixture(t);
  const root = await create(input("tech", "DEPARTMENT"));
  const first = await create(input("first", "CATEGORY", root.id));
  const second = await create(input("second", "CATEGORY", root.id));
  const expected = { parentId: root.id, siblings: [second, first].map(({ id, revision }) => ({ id, revision })) };
  await assert.rejects(reorderCategories(ownerId, { ...expected, siblings: [expected.siblings[0]] }), /siblings changed/);
  const reordered = await reorderCategories(ownerId, expected);
  assert.deepEqual(reordered.map(({ id, position }) => [id, position]), [[second.id, 0], [first.id, 1]]);
  await assert.rejects(reorderCategories(ownerId, expected), /siblings changed/);
  const archived = await archiveCategory(ownerId, { id: first.id, revision: reordered[1].revision });
  assert.equal(archived.id, first.id);
  assert.equal(archived.slug, first.slug);
  assert.equal(archived.state, "ARCHIVED");
  await assert.rejects(saveCategory(ownerId, input("under-archive", "SUBCATEGORY", first.id)), /available parent/);
});

test("localized slug aliases and market presentation are stored independently", async (t) => {
  const { ownerId, packerId, input, create, legacy } = await fixture(t);
  const fields = input("gadgets", "DEPARTMENT");
  const row = await create(fields);
  const renamed = await saveCategory(ownerId, { ...fields, slug: fields.slug + "-new", revision: row.revision });
  assert.equal((await db.departmentSlugAlias.findUniqueOrThrow({ where: { locale_slug: { locale: "", slug: row.slug } } })).departmentId, row.id);
  await assert.rejects(legacy({ ...input("collision", "DEPARTMENT"), slug: row.slug }), /reserved/);
  const labels = { name: "যন্ত্রপাতি", shortName: "যন্ত্র", description: "দোকানের যন্ত্রপাতি", slug: "যন্ত্রপাতি" };
  const translated = await saveCategoryTranslation(ownerId, { id: row.id, revision: renamed.revision, locale: "bn-bd", translation: labels });
  const key = { departmentId: row.id, locale: "bn-BD" };
  assert.equal((await db.departmentTranslation.findUniqueOrThrow({ where: { departmentId_locale: key } })).name, labels.name);
  const translatedAgain = await saveCategoryTranslation(ownerId, {
    id: row.id, revision: translated.revision, locale: "bn-BD", translation: { ...labels, slug: "সাজানো-যন্ত্র" },
  });
  assert.equal((await db.departmentSlugAlias.findUniqueOrThrow({ where: { locale_slug: { locale: "bn-BD", slug: labels.slug } } })).departmentId, row.id);
  const other = await create(input("another", "DEPARTMENT"));
  await assert.rejects(saveCategoryTranslation(ownerId, {
    id: other.id, revision: other.revision, locale: "bn-BD", translation: labels,
  }), /reserved/);
  await assert.rejects(saveCategoryMarketPresentation(packerId, { id: row.id, revision: translatedAgain.revision,
    marketId: "bd", presentation: { visibleInNavigation: false } }), /permission/);
  await assert.rejects(saveCategoryMarketPresentation(ownerId, { id: row.id, revision: translatedAgain.revision,
    marketId: "invalid", presentation: { visibleInNavigation: false } }), /configured market/);
  const market = await saveCategoryMarketPresentation(ownerId, { id: row.id, revision: translatedAgain.revision,
    marketId: "bd", presentation: { visibleInNavigation: false, position: 8, image } });
  assert.equal(market.state, "ACTIVE");
  assert.equal(market.slug, renamed.slug);
  assert.deepEqual(await db.departmentMarketPresentation.findMany({ where: { departmentId: row.id },
    select: { marketId: true, position: true, visibleInNavigation: true } }),
  [{ marketId: "bd", position: 8, visibleInNavigation: false }]);
  const bd = await resolveCategorySlug(labels.slug, "bd", "bn-BD");
  const us = await resolveCategorySlug(row.slug, "us", "bn-BD");
  assert.equal(bd?.redirectSlug, "সাজানো-যন্ত্র");
  assert.equal(us?.redirectSlug, renamed.slug);
  assert.equal(bd?.category.id, row.id);
  assert.equal(us?.category.name, labels.name);
  assert.equal(bd?.category.visibleInNavigation, false);
  assert.equal(bd?.category.position, 8);
  assert.equal(us?.category.visibleInNavigation, true);
  assert.equal(us?.category.position, 0);

  await saveCategoryTranslation(ownerId, { id: other.id, revision: other.revision, locale: "bn", translation: labels });
  const fallback = (await listCategoryPresentation("us", "bn-BD")).find(category => category.id === other.id);
  assert.equal(fallback?.name, labels.name);
  assert.equal(fallback?.localizedSlug, other.slug);
});
