import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { listCategoryPresentation, resolveCategorySlug } from "../../src/lib/catalog/category-presentation.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveProductCategoryAssignments } from "../../src/lib/staff/category-assignments.ts";
import {
  archiveCategory, moveCategory, saveCategory, saveCategoryMarketPresentation, saveCategoryTranslation,
} from "../../src/lib/staff/taxonomy.ts";
import { readCategoryImpact } from "../../src/lib/staff/taxonomy-impact.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());
const image = { src: "/catalog/phone-stand.webp", alt: "Category fixture" };
const banner = { src: "/editorial/hero.webp", alt: "Category banner" };

test("category workspace preserves assignments during moves and scopes market presentation", async t => {
  const key = `workspace-${randomUUID().slice(0, 8)}`;
  const [root, first, second, leaf, alternate, empty, product, owner, merchandiser] =
    ["root", "first", "second", "leaf", "alternate", "empty", "product", "owner", "market"].map(name => `${key}-${name}`);
  const variant = "v-" + product;
  const categoryIds = [root, first, second, leaf, alternate, empty];
  await db.user.createMany({ data: [owner, merchandiser].map(id => ({ id, name: "Category workspace fixture", email: `${id}@example.invalid` })) });
  t.after(async () => {
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: { in: categoryIds } } });
    await db.departmentTranslation.deleteMany({ where: { departmentId: { in: categoryIds } } });
    await db.departmentSlugAlias.deleteMany({ where: { departmentId: { in: categoryIds } } });
    await db.marketOffer.deleteMany({ where: { variantId: variant } });
    await db.inventory.deleteMany({ where: { variantId: variant } });
    await db.variant.deleteMany({ where: { id: variant } });
    await db.product.deleteMany({ where: { id: product } });
    for (const id of [...categoryIds].reverse()) await db.department.deleteMany({ where: { id } });
    await db.auditEvent.deleteMany({ where: { actorId: { in: [owner, merchandiser] } } });
    await db.user.deleteMany({ where: { id: { in: [owner, merchandiser] } } });
  });
  await db.staffAccess.createMany({ data: [{ userId: owner, role: "OWNER" }, { userId: merchandiser, role: "PACKER" }] });
  await db.staffMarketAccess.create({ data: { userId: merchandiser, marketId: "bd", merchandising: true } });

  const category = (id: string, kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY", parentId: string | null) => ({
    id, slug: id, name: "Workspace category", shortName: "Workspace", description: "Isolated category fixture",
    image, state: "ACTIVE", position: 10, kind, parentId, revision: null,
  } as const);
  await saveCategory(owner, category(root, "DEPARTMENT", null));
  await saveCategory(owner, category(first, "CATEGORY", root));
  await saveCategory(owner, category(second, "CATEGORY", root));
  const before = await saveCategory(owner, { ...category(leaf, "SUBCATEGORY", first),
    banner, seoTitle: "Browse protective cases", seoDescription: "Category page description" });
  await saveCategory(owner, category(alternate, "SUBCATEGORY", first));
  const emptyRow = await saveCategory(owner, category(empty, "SUBCATEGORY", first));
  assert.equal(before.bannerSrc, banner.src);
  assert.equal(before.bannerAlt, banner.alt);
  assert.equal(before.seoTitle, "Browse protective cases");

  await db.product.create({ data: {
    id: product, slug: product, departmentId: alternate, name: "Workspace fixture", brand: "Fixture",
    description: "Isolated product fixture", specifications: [], keywords: [], position: 20, addedOn: new Date(),
    publication: "ACTIVE",
  } });
  await db.variant.create({ data: { id: variant, sku: product.toUpperCase(), productId: product, options: {}, label: "Standard", position: 0 } });
  await db.inventory.create({ data: { variantId: variant, available: 9 } });
  await db.marketOffer.create({ data: { variantId: variant, marketId: "bd", amountMinor: 145000, currency: "BDT" } });
  await saveProductCategoryAssignments(owner, { productId: product, revision: 0, primaryCategoryId: leaf, secondaryCategoryIds: [alternate] });

  const impact = await readCategoryImpact(owner, first);
  assert.equal(impact.descendantProducts, 1);
  assert.equal(impact.activeChildren, 3);
  assert.equal(impact.canArchive, false);
  await assert.rejects(readCategoryImpact(merchandiser, leaf), { code: "forbidden" });
  assert.equal((await readCategoryImpact(owner, leaf)).activeDirect, 1);
  await assert.rejects(archiveCategory(owner, { id: leaf, revision: before.revision }), /Reassign or retire/);
  await assert.rejects(moveCategory(owner, { id: leaf, revision: before.revision, parentId: leaf }), /descendants/);
  await assert.rejects(moveCategory(merchandiser, { id: leaf, revision: before.revision, parentId: second }), { code: "forbidden" });
  const moved = await moveCategory(owner, { id: leaf, revision: before.revision, parentId: second });
  assert.equal(moved.parentId, second);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: product } })).departmentId, leaf);
  assert.equal(await db.productSecondaryCategory.count({ where: { productId: product, departmentId: alternate } }), 1);
  assert.equal(await db.variant.count({ where: { productId: product } }), 1);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: variant } })).available, 9);
  assert.equal(moved.seoTitle, before.seoTitle);
  assert.equal(moved.bannerSrc, before.bannerSrc);

  const renamed = await saveCategory(owner, { ...category(leaf, "SUBCATEGORY", second), revision: moved.revision, slug: leaf + "-renamed" });
  assert.equal(renamed.bannerSrc, before.bannerSrc);
  assert.equal((await resolveCategorySlug(leaf, "bd", "en-BD"))?.redirectSlug, renamed.slug);
  const translated = await saveCategoryTranslation(owner, { id: leaf, revision: renamed.revision, locale: "bn-BD",
    translation: { name: "সুরক্ষা", shortName: "কেস", description: "স্থানীয় বিভাগ", slug: "কেস" } });
  assert.equal((await resolveCategorySlug("কেস", "bd", "bn-BD"))?.category.id, leaf);
  await assert.rejects(saveCategoryMarketPresentation(merchandiser, { id: leaf, revision: translated.revision, marketId: "us",
    presentation: { visibleInNavigation: false } }), { code: "forbidden" });
  await saveCategoryMarketPresentation(merchandiser, { id: leaf, revision: translated.revision, marketId: "bd",
    presentation: { visibleInNavigation: false, position: 55 } });
  const bd = (await listCategoryPresentation("bd", "bn-BD")).find(item => item.id === leaf);
  const us = (await listCategoryPresentation("us", "en-US")).find(item => item.id === leaf);
  assert.equal(bd?.visibleInNavigation, false);
  assert.equal(bd?.position, 55);
  assert.equal(bd?.seoTitle, before.seoTitle);
  assert.equal(bd?.banner?.alt, banner.alt);
  assert.equal(us?.visibleInNavigation, true);
  assert.equal((await db.marketOffer.findUniqueOrThrow({ where: { variantId_marketId: { variantId: variant, marketId: "bd" } } })).eligible, true);
  assert.equal((await readCategoryImpact(owner, empty)).canArchive, true);
  assert.equal((await archiveCategory(owner, { id: empty, revision: emptyRow.revision })).state, "ARCHIVED");
  assert.equal((await db.auditEvent.count({ where: { target: leaf, action: "TAXONOMY_SAVED" } })) >= 5, true);
});
