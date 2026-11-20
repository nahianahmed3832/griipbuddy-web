import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { applyCatalogMigration, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveProductCategoryAssignments } from "../../src/lib/staff/category-assignments.ts";
import { saveCatalogAttributeDefinition, saveCategoryAttributeTemplate } from "../../src/lib/staff/category-attributes.ts";
import { categoryAssignmentProducts } from "../../src/lib/staff/taxonomy-assignment-read.ts";
import { categoryAttributeWorkspace, previewCategoryAttributeImpact } from "../../src/lib/staff/taxonomy-attribute-read.ts";
import { createCatalogMigrationFixture } from "./catalog-migration-fixture.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function fixture(t: TestContext) {
  const source = await createCatalogMigrationFixture(db);
  const owner = `${source.key}-workspace-owner`;
  const work = `${source.key}-workspace-staff`;
  const attr = `${source.key}-workspace-material`;
  const isolation = process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
  const checkpoints: string[] = [];
  process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
  t.after(async () => {
    try {
      await db.categoryAttributeTemplate.deleteMany({ where: { attributeId: attr } });
      await db.catalogAttributeDefinition.deleteMany({ where: { id: attr } });
      await db.auditEvent.deleteMany({ where: { actorId: owner } });
      await source.cleanup(checkpoints);
      await db.staffAccess.deleteMany({ where: { userId: { in: [owner, work] } } });
      await db.user.deleteMany({ where: { id: { in: [owner, work] } } });
    } finally {
      if (isolation === undefined) delete process.env.GRIIP_CATALOG_MIGRATION_ISOLATED;
      else process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = isolation;
    }
  });
  await db.user.createMany({ data: [owner, work].map(id => ({ id, name: id, email: `${id}@example.test` })) });
  await db.staffAccess.createMany({ data: [{ userId: owner, role: "OWNER" }, { userId: work, role: "PACKER" }] });
  await db.staffMarketAccess.create({ data: { userId: work, marketId: "bd", merchandising: true } });
  const plan = await dryRunCatalogMigration(source.manifest);
  checkpoints.push(plan.digest);
  await applyCatalogMigration(plan);
  return { ...source, owner, work, attr };
}

test("workspace separates direct and descendant assignments and atomically swaps a connected primary without touching inventory", async t => {
  const { owner, work, caseProductId, caseSku, locationId, categories } = await fixture(t);
  const search = (actor: string, categoryId: string, scope: "direct" | "descendants" | "all", page?: string) =>
    categoryAssignmentProducts(actor, { categoryId, scope, q: caseSku, page });
  const direct = await search(owner, categories.casesLeafId, "direct");
  assert.equal(direct.total, 1);
  assert.equal(direct.products[0].primaryCategoryId, categories.casesLeafId);
  assert.deepEqual(direct.products[0].secondaryCategoryIds, [categories.travelLeafId]);
  assert.equal(direct.products[0].placement, "direct");
  const descendants = await search(owner, categories.departmentId, "descendants");
  assert.deepEqual(descendants.products.map(row => [row.id, row.placement]), [[caseProductId, "descendant"]]);
  assert.equal((await search(owner, categories.departmentId, "direct")).total, 0);
  assert.deepEqual((await search(owner, categories.departmentId, "all", "2")).products, []);
  await assert.rejects(search(work, categories.departmentId, "all"), { code: "forbidden" });
  const stock = () => db.inventoryPool.findMany({ where: { locationId }, orderBy: { id: "asc" } });
  const before = await stock();
  const input = { productId: caseProductId, revision: direct.products[0].revision,
    primaryCategoryId: categories.travelLeafId, secondaryCategoryIds: [categories.casesLeafId] };
  await assert.rejects(saveProductCategoryAssignments(work, input), { code: "forbidden" });
  await assert.rejects(saveProductCategoryAssignments(owner, { ...input, secondaryCategoryIds: [categories.travelLeafId] }), { code: "invalid_input" });
  const written = await saveProductCategoryAssignments(owner, input);
  assert.equal(written.revision, input.revision + 1);
  assert.equal((await search(owner, categories.travelLeafId, "direct")).products[0].primaryCategoryId, categories.travelLeafId);
  assert.deepEqual((await search(owner, categories.departmentId, "all")).products.map(row => row.id), [caseProductId]);
  assert.deepEqual(await stock(), before);
  assert.equal(await db.auditEvent.count({ where: { actorId: owner, target: caseProductId, action: "TAXONOMY_SAVED" } }), 1);
});

test("attribute impact uses effective primary-category inheritance and retains existing typed data", async t => {
  const { owner, work, attr, caseProductId, accessoryProductId, categories } = await fixture(t);
  const revision = async (id: string) => (await db.department.findUniqueOrThrow({ where: { id } })).revision;
  await saveCatalogAttributeDefinition(owner, { id: attr, name: "Material", dataType: "ENUM", scope: "PRODUCT", allowedValues: ["Hard shell", "Fabric"] });
  await saveCategoryAttributeTemplate(owner, { departmentId: categories.travelLeafId, attributeId: attr,
    expectedRevision: await revision(categories.travelLeafId),
    template: { required: false, filterable: false, position: 20, inheritable: false } });

  const proposal = { departmentId: categories.departmentId, attributeId: attr,
    expectedRevision: await revision(categories.departmentId), template: { required: true, filterable: true, position: 1, inheritable: true } };
  const preview = await previewCategoryAttributeImpact(owner, proposal);
  assert.deepEqual(preview.products.map(row => [row.id, row.reasons]), [[caseProductId, ["required"]]]);
  assert.equal(preview.published, 1);
  assert.ok(!preview.products.some(row => row.id === accessoryProductId));
  assert.equal(await revision(categories.departmentId), proposal.expectedRevision);
  await assert.rejects(previewCategoryAttributeImpact(work, proposal), { code: "forbidden" });
  await saveCategoryAttributeTemplate(owner, proposal);
  const workspace = await categoryAttributeWorkspace(owner, { categoryId: categories.casesLeafId });
  assert.equal(workspace.effective[0].sourceDepartmentId, categories.departmentId);
  assert.equal(workspace.effective[0].required, true);
  assert.equal(workspace.local.length, 0);
  await db.product.update({ where: { id: caseProductId }, data: { attributeValues: { [attr]: "Hard shell" } } });
  const removal = { ...proposal, expectedRevision: await revision(categories.departmentId), template: null };
  assert.deepEqual((await previewCategoryAttributeImpact(owner, removal)).products.map(row => row.reasons), [["not_applicable"]]);
  await saveCategoryAttributeTemplate(owner, removal);
  assert.deepEqual((await db.product.findUniqueOrThrow({ where: { id: caseProductId } })).attributeValues, { [attr]: "Hard shell" });
});
