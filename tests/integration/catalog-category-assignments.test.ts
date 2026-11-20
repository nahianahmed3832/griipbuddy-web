import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { catalog, listCategoryProductIds } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveProductCategoryAssignments } from "../../src/lib/staff/category-assignments.ts";
import { saveCategory, saveCategoryMarketPresentation } from "../../src/lib/staff/taxonomy.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("category assignments are atomic, market-scoped and distinct across descendant branches", async t => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const packer = await db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true } });
  const prefix = `stage2-placements-${randomUUID()}`;
  const productId = `${prefix}-case`;
  const variantId = `${prefix}-case-sku`;
  const sku = `FIX-${randomUUID()}`.toUpperCase();
  const legacy = await db.department.findFirstOrThrow({ where: { kind: null, state: "ACTIVE" } });
  async function node(suffix: string, kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY", parentId: string | null) {
    const id = `${prefix}-${suffix}`;
    const input = {
      id, slug: id, name: suffix, shortName: suffix, description: "Stage 2 synthetic category", state: "ACTIVE", kind, parentId,
      position: 0, image: { src: "/editorial/hero.webp", alt: "Fixture" },
    } as const;
    const row = await saveCategory(owner.userId, { ...input, revision: null });
    return { input, row };
  }
  t.after(async () => {
    await db.marketOffer.deleteMany({ where: { variantId } });
    await db.inventory.deleteMany({ where: { variantId } });
    await db.variant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: { startsWith: prefix } } });
    await db.auditEvent.deleteMany({ where: { target: { startsWith: prefix } } });
    for (const kind of ["SUBCATEGORY", "CATEGORY", "DEPARTMENT"] as const) {
      await db.department.deleteMany({ where: { id: { startsWith: prefix }, kind } });
    }
  });
  const { row: root } = await node("tech", "DEPARTMENT", null);
  const { row: otherRoot } = await node("travel", "DEPARTMENT", null);
  const { row: cases } = await node("cases", "CATEGORY", root.id);
  const { input: accessoriesInput, row: accessories } = await node("accessories", "CATEGORY", root.id);
  const { row: leaf } = await node("protective", "SUBCATEGORY", cases.id);
  const { row: alternate } = await node("attachments", "SUBCATEGORY", accessories.id);
  await db.product.create({ data: {
    id: productId, slug: productId, departmentId: legacy.id, name: "Synthetic case", description: "Stage 2 product",
    specifications: [], keywords: [], addedOn: new Date(), position: 1, publication: "ACTIVE",
    variants: { create: { id: variantId, sku, options: {}, label: "Standard", position: 0,
      inventory: { create: { available: 7 } },
      offers: { create: [{ marketId: "bd", currency: "BDT", amountMinor: 129_000 }, { marketId: "us", currency: "USD", amountMinor: 1999 }] },
    } },
  } });
  const input = { productId, revision: 0, primaryCategoryId: leaf.id, secondaryCategoryIds: [alternate.id] };
  await assert.rejects(saveProductCategoryAssignments(packer.userId, input), /permission/);
  await assert.rejects(saveProductCategoryAssignments(owner.userId, { ...input, primaryCategoryId: cases.id }), /active subcategories/);
  await assert.rejects(saveProductCategoryAssignments(owner.userId, { ...input, primaryCategoryId: null }), /primaryCategoryId/);
  await assert.rejects(saveProductCategoryAssignments(owner.userId, { ...input, secondaryCategoryIds: [leaf.id] }), /only once/);
  await assert.rejects(saveProductCategoryAssignments(owner.userId, { ...input, secondaryCategoryIds: [alternate.id, alternate.id] }), /only once/);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: productId } })).departmentId, legacy.id);

  const results = await Promise.allSettled([1, 2].map(() => saveProductCategoryAssignments(owner.userId, input)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.match(String(rejected?.reason), /product changed/i);
  for (const marketId of ["bd", "us"] as const) {
    assert.deepEqual(await listCategoryProductIds(root.id, marketId), [productId]);
    assert.deepEqual(await listCategoryProductIds(cases.id, marketId), [productId]);
    assert.deepEqual(await listCategoryProductIds(accessories.id, marketId), [productId]);
  }
  const placement = { productId, primaryDepartmentId: leaf.id, departmentId: alternate.id };
  await assert.rejects(db.productSecondaryCategory.create({ data: placement }), /unique constraint/i);
  await assert.rejects(db.productSecondaryCategory.create({ data: { ...placement, departmentId: leaf.id } }), /distinct_primary_check/);
  await assert.rejects(db.product.update({ where: { id: productId }, data: { departmentId: alternate.id } }), /distinct_primary_check/);
  assert.deepEqual(await db.productSecondaryCategory.findMany({ where: { productId } }), [placement]);

  const moved = await saveCategory(owner.userId, { ...accessoriesInput, parentId: otherRoot.id, revision: accessories.revision });
  await saveCategoryMarketPresentation(owner.userId, { id: moved.id, revision: moved.revision, marketId: "bd",
    presentation: { visibleInNavigation: false } });
  assert.deepEqual(await listCategoryProductIds(otherRoot.id, "bd"), [productId]);
  assert.ok(await catalog.getProduct(productId, "bd"));

  const swapped = await saveProductCategoryAssignments(owner.userId, {
    productId, revision: 1, primaryCategoryId: alternate.id, secondaryCategoryIds: [leaf.id],
  });
  assert.equal(swapped.revision, 2);
  assert.deepEqual(await db.productSecondaryCategory.findMany({ where: { productId } }), [{
    productId, primaryDepartmentId: alternate.id, departmentId: leaf.id,
  }]);
  assert.deepEqual(await catalog.resolveVariants([variantId], "bd").then(items => items.map(({ variantId, offer }) =>
    [variantId, offer?.amountMinor, offer?.stock])), [[variantId, 129_000, 7]]);
  const variant = await db.variant.findMany({ where: { productId }, select: { id: true, sku: true } });
  assert.deepEqual(variant, [{ id: variantId, sku }]);
});
