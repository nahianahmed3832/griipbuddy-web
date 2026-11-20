import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { resolveDepartmentRedirect } from "../../src/lib/catalog/category-redirect.ts";
import { readCategoryBusinessCodes, resolveCategoryBusinessCode, resolveRecoveredCategoryId } from "../../src/lib/catalog/category-reference.ts";
import { connectedCategoryDetail } from "../../src/lib/catalog/connected-navigation.ts";
import { migrationVersion } from "../../src/lib/catalog-migration/contracts.ts";
import { applyCatalogMigration, catalogMigrationTarget, dryRunCatalogMigration } from "../../src/lib/catalog-migration/engine.ts";
import type { MigrationManifest } from "../../src/lib/catalog-migration/manifest.ts";
import { migrationMarkdown } from "../../src/lib/catalog-migration/report.ts";
import { getDb } from "../../src/lib/db/client.ts";

process.env.GRIIP_CATALOG_MIGRATION_ISOLATED = "1";
catalogMigrationTarget();
const db = getDb();
after(() => db.$disconnect());

async function categoryFixture() {
  const key = `category-reconciliation-${randomBytes(5).toString("hex")}`;
  const ids = [`${key}-root`, `${key}-branch`, `${key}-leaf`, `${key}-secondary`];
  const [root, branch, leaf, secondary] = ids;
  const [mongoRoot, mongoBranch, mongoLeaf] = Array.from({ length: 3 }, () => randomBytes(12).toString("hex"));
  const code = `PACK-${key.slice(-10).toUpperCase()}`;
  const oldSlug = `${key}-old-link`;
  const localizedSlug = `${key}-bn`;
  const productId = `${key}-product`;
  const values = { name: "Travel packing", shortName: "Packing", description: "Synthetic reviewed category", position: 0,
    imageSrc: "/catalog/phone-stand.webp", imageAlt: "Fixture category image" };
  await db.$transaction(async tx => {
    await tx.department.create({ data: { ...values, id: root, slug: root, kind: "DEPARTMENT" } });
    await tx.department.create({ data: { ...values, id: branch, slug: branch, parentId: root, kind: "CATEGORY" } });
    await tx.department.createMany({ data: [leaf, secondary].map(id => ({ ...values, id, slug: id, parentId: branch, kind: "SUBCATEGORY" })) });
    await tx.departmentMarketPresentation.create({ data: { departmentId: leaf, marketId: "us", visibleInNavigation: false, position: 23 } });
    await tx.product.create({ data: { id: productId, slug: productId, departmentId: leaf, name: "Fixture packing cubes",
      description: "Fixture product with a legacy category placement", keywords: [], specifications: [], addedOn: new Date(),
      position: 0, publication: "ACTIVE" } });
    await tx.productSecondaryCategory.create({ data: { productId, primaryDepartmentId: leaf, departmentId: secondary } });
  });

  const manifest: MigrationManifest = { version: migrationVersion, sourceKind: "representative-fixtures", categories: [], batches: [],
    legacyCategories: [
      { sourceId: mongoRoot, collection: "categories", sourceParentId: null, targetId: root, evidence: "fixture-taxonomy-review/root" },
      { sourceId: mongoBranch, collection: "subcategories", sourceParentId: mongoRoot, targetId: branch, evidence: "fixture-taxonomy-review/branch" },
      { sourceId: mongoLeaf, collection: "sub_subcategories", sourceParentId: mongoBranch, targetId: leaf,
        evidence: "fixture-taxonomy-review/leaf", codes: [{ namespace: "buying", value: code }], aliases: [{ locale: "", slug: oldSlug }],
        translations: [{ locale: "bn-BD", name: "ভ্রমণের ব্যাগ", shortName: "ভ্রমণ", description: "ভ্রমণের জন্য", slug: localizedSlug }],
      },
    ],
  };
  const runs: string[] = [];
  async function cleanup() {
    const runId = { in: runs };
    await db.catalogMigrationCheckpoint.deleteMany({ where: { runId } });
    await db.catalogMigrationMapping.deleteMany({ where: { runId } });
    await db.catalogMigrationRun.deleteMany({ where: { id: runId } });
    await db.departmentTranslation.deleteMany({ where: { departmentId: { in: ids } } });
    await db.departmentSlugAlias.deleteMany({ where: { departmentId: { in: ids } } });
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: leaf } });
    await db.productSecondaryCategory.deleteMany({ where: { productId } });
    await db.product.deleteMany({ where: { id: productId } });
    for (const id of [...ids].reverse()) await db.department.deleteMany({ where: { id } });
  }
  return { manifest, root, branch, leaf, secondary, mongoLeaf, mongoBranch, code, oldSlug, localizedSlug, productId, runs, cleanup };
}

test("reviewed category-only adoption preserves external identity, translations, placements and market settings", async t => {
  const fixture = await categoryFixture();
  t.after(fixture.cleanup);
  const { leaf, secondary, code, mongoLeaf, oldSlug, localizedSlug, productId } = fixture;
  const plan = await dryRunCatalogMigration(fixture.manifest);
  fixture.runs.push(plan.digest);
  assert.deepEqual(plan.batches[0].issues, []);
  assert.deepEqual(plan.batches[0].reconciliation, { categories: 0, recoveredCategories: 3, businessCodes: 1, newAliases: 1, newTranslations: 1 });
  assert.match(migrationMarkdown(plan), /Reviewed 3 source categories and 1 business code/);
  assert.equal(await resolveRecoveredCategoryId(mongoLeaf, db), null);
  assert.equal(await db.departmentTranslation.count({ where: { departmentId: leaf } }), 0);

  const applied = await applyCatalogMigration(plan);
  assert.equal(applied.appliedBatches, 1);
  assert.match(migrationMarkdown(applied), /1 URL alias and 1 translation/);
  assert.equal((await applyCatalogMigration(plan)).appliedBatches, 0);
  assert.equal(await resolveRecoveredCategoryId(mongoLeaf, db), leaf);
  assert.equal(await resolveCategoryBusinessCode("buying", code, db), leaf);
  assert.equal(await resolveCategoryBusinessCode("shopping", code, db), null);
  assert.equal(await resolveCategoryBusinessCode("buying", oldSlug, db), null);
  assert.deepEqual(await readCategoryBusinessCodes(leaf, db), [{ namespace: "buying", value: code }]);
  assert.equal(await resolveDepartmentRedirect(mongoLeaf, "bd", "bn-BD", db), localizedSlug);
  assert.equal(await resolveDepartmentRedirect(oldSlug, "us", "en-US", db), leaf);
  assert.equal(await resolveDepartmentRedirect(code, "us", "en-US", db), null);
  const localized = await connectedCategoryDetail(mongoLeaf, { marketId: "bd", locale: "bn-BD" }, db);
  assert.equal(localized?.category.name, "ভ্রমণের ব্যাগ");
  assert.equal(localized?.category.parentId, fixture.branch);
  assert.equal(localized?.redirectSlug, localizedSlug);
  const { departmentId, secondaryCategories } = await db.product.findUniqueOrThrow({ where: { id: productId },
    include: { secondaryCategories: true } });
  assert.equal(departmentId, leaf);
  assert.deepEqual(secondaryCategories.map(row => row.departmentId), [secondary]);
  const market = await connectedCategoryDetail(mongoLeaf, { marketId: "us", locale: "en-US" }, db);
  assert.equal(market?.category.visibleInNavigation, false);
  assert.equal(market.category.position, 23);

  await db.department.update({ where: { id: leaf }, data: { slug: `${leaf}-renamed`, revision: { increment: 1 } } });
  assert.equal(await resolveCategoryBusinessCode("buying", code, db), leaf);
  assert.equal(await resolveDepartmentRedirect(oldSlug, "us", "en-US", db), `${leaf}-renamed`);
  await assert.rejects(applyCatalogMigration(plan), { code: "target-changed" });
});

test("category reconciliation blocks duplicate codes, cross-category URLs and unrepresentable fourth-level ancestry", async t => {
  const fixture = await categoryFixture();
  t.after(fixture.cleanup);
  const { manifest, root, leaf, mongoLeaf, code } = fixture;
  await db.department.update({ where: { id: fixture.secondary }, data: { slug: mongoLeaf } });
  const [parent, branch, target] = manifest.legacyCategories!;
  const conflicting: MigrationManifest = { ...manifest, legacyCategories: [
    { ...parent, codes: [{ namespace: "buying", value: code }] }, branch,
    { ...target, aliases: [{ locale: "", slug: root }] },
    { sourceId: randomBytes(12).toString("hex"), collection: "third_subcategories", sourceParentId: mongoLeaf,
      targetId: leaf, evidence: "fixture-taxonomy-review/fourth-level" },
  ] };
  const plan = await dryRunCatalogMigration(conflicting);
  assert.ok(plan.batches[0].issues.some(issue => issue.code === "unsupported-category-depth"));
  assert.ok(plan.batches[0].issues.some(issue => issue.code === "category-code-conflict"));
  assert.ok(plan.batches[0].issues.some(issue => issue.code === "category-slug-conflict"));
  assert.ok(plan.batches[0].issues.some(issue => issue.code === "category-reference-conflict"));
  assert.ok(plan.batches[0].issues.some(issue => issue.code === "ambiguous-category-target"));
  await assert.rejects(applyCatalogMigration(plan), { code: "unresolved-conflicts" });
  assert.equal(await resolveRecoveredCategoryId(mongoLeaf, db), null);
  assert.equal(await db.departmentTranslation.count({ where: { departmentId: leaf } }), 0);
  assert.equal(await db.catalogMigrationRun.count({ where: { id: plan.digest } }), 0);
});
