import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import "../../scripts/load-env.ts";
import { categoryAttributes, productCategoryAttributes, validateCategoryAttributeValues } from "../../src/lib/catalog/category-attributes.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveCatalogAttributeDefinition, saveCategoryAttributeTemplate } from "../../src/lib/staff/category-attributes.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const prefix = "stage2-attributes-" + randomUUID().slice(0, 8) + "-";
const owner = prefix + "owner";
const packer = prefix + "packer";
const root = prefix + "root";
const branch = prefix + "branch";
const leaf = prefix + "leaf";
const otherLeaf = prefix + "other-leaf";
const product = prefix + "product";
const material = prefix + "material";
const defaults = { required: false, filterable: true, position: 20 };

before(async () => {
  await db.$transaction(async tx => {
    await tx.user.create({ data: { id: owner, name: "Template owner", email: owner + "@example.invalid", staff: { create: { role: "OWNER" } } } });
    await tx.user.create({ data: { id: packer, name: "Template packer", email: packer + "@example.invalid", staff: { create: { role: "PACKER" } } } });
    const presentation = { name: "Template fixture", shortName: "Template", description: "", imageSrc: "", imageAlt: "", position: 0 };
    await tx.department.create({ data: { id: root, slug: root, kind: "DEPARTMENT", ...presentation } });
    await tx.department.create({ data: { id: branch, slug: branch, kind: "CATEGORY", parentId: root, ...presentation } });
    await tx.department.createMany({ data: [leaf, otherLeaf].map(id => ({
      id, slug: id, kind: "SUBCATEGORY", parentId: branch, ...presentation,
    })) });
    await tx.product.create({ data: {
      id: product, slug: product, name: "Attribute fixture", departmentId: leaf, description: "",
      specifications: [], keywords: [], addedOn: new Date("2026-01-01"), position: 0, publication: "ACTIVE",
      secondaryCategories: { create: { departmentId: otherLeaf } },
    } });
  });
  await saveCatalogAttributeDefinition(owner, { id: material, name: "Material", scope: "PRODUCT", dataType: "TEXT" });
  await setRule(root, material, { ...defaults, required: true });
});

after(async () => {
  try {
    await db.productSecondaryCategory.deleteMany({ where: { productId: product } });
    await db.product.deleteMany({ where: { id: product } });
    await db.categoryAttributeTemplate.deleteMany({ where: { departmentId: { startsWith: prefix } } });
    await db.catalogAttributeDefinition.deleteMany({ where: { id: { startsWith: prefix } } });
    for (const id of [otherLeaf, leaf, branch, root]) await db.department.deleteMany({ where: { id } });
    await db.auditEvent.deleteMany({ where: { actorId: { in: [owner, packer] } } });
    await db.user.deleteMany({ where: { id: { in: [owner, packer] } } });
  } finally {
    await db.$disconnect();
  }
});

async function setRule(departmentId: string, attributeId: string, template: unknown) {
  const { revision } = await db.department.findUniqueOrThrow({ where: { id: departmentId }, select: { revision: true } });
  return saveCategoryAttributeTemplate(owner, { departmentId, attributeId, expectedRevision: revision, template });
}

test("nearest templates inherit, override, mask and restore through the primary category", async () => {
  const warranty = prefix + "warranty";
  const travel = prefix + "travel";
  await saveCatalogAttributeDefinition(owner, { id: warranty, name: "Warranty", scope: "PRODUCT", dataType: "BOOLEAN" });
  await saveCatalogAttributeDefinition(owner, { id: travel, name: "Travel grade", scope: "PRODUCT", dataType: "NUMBER" });
  await assert.rejects(saveCategoryAttributeTemplate(packer, {
    departmentId: root, attributeId: material, expectedRevision: 0, template: defaults,
  }), /permission/i);
  await setRule(root, warranty, { ...defaults, position: 10 });
  await setRule(branch, material, { ...defaults, inheritable: false, filterable: false });
  await setRule(branch, warranty, { ...defaults, excluded: true });
  await setRule(otherLeaf, travel, defaults);

  const branchAttributes = await categoryAttributes(branch);
  assert.deepEqual(branchAttributes.map(row => [row.id, row.required, row.filterable, row.sourceDepartmentId]),
    [[material, false, false, branch]]);
  assert.deepEqual((await categoryAttributes(leaf)).map(row => [row.id, row.required, row.sourceDepartmentId]),
    [[material, true, root]]);
  assert.ok((await categoryAttributes(otherLeaf)).some(row => row.id === travel));

  const { revision } = await setRule(leaf, warranty, { ...defaults, position: 5 });
  const assignedTemplates = await productCategoryAttributes(product);
  assert.deepEqual(assignedTemplates?.map(row => [row.id, row.sourceDepartmentId]), [[warranty, leaf], [material, root]]);
  await assert.rejects(saveCategoryAttributeTemplate(owner, {
    departmentId: leaf, attributeId: warranty, expectedRevision: revision - 1, template: null,
  }), /category changed/i);
  await setRule(leaf, warranty, null);
  assert.deepEqual((await categoryAttributes(leaf)).map(row => row.id), [material]);
  assert.equal(await productCategoryAttributes(prefix + "missing"), null);
});

test("template values respect scope, type and existing variant option keys", async () => {
  const width = prefix + "width";
  const washable = prefix + "washable";
  const colour = prefix + "colour";
  const variantOptionKey = "Colour " + prefix.slice(-9, -1);
  const definition = {
    id: colour, name: "Colour", scope: "VARIANT", dataType: "ENUM", allowedValues: ["Blue", "Black"], variantOptionKey,
  };
  await assert.rejects(saveCatalogAttributeDefinition(packer, definition), /permission/i);
  await assert.rejects(saveCatalogAttributeDefinition(owner, { ...definition, allowedValues: ["Blue", "Blue"] }), /unique/i);
  await assert.rejects(saveCatalogAttributeDefinition(owner, { ...definition, scope: "PRODUCT" }), /option key/i);
  await saveCatalogAttributeDefinition(owner, definition);
  await assert.rejects(saveCatalogAttributeDefinition(owner, { ...definition, id: colour + "-duplicate" }), /already bound/i);
  await assert.rejects(saveCatalogAttributeDefinition(owner, { ...definition, allowedValues: ["Blue"] }), /removing allowed values/i);
  await assert.rejects(saveCatalogAttributeDefinition(owner, { ...definition, variantOptionKey: null }), /fixed/i);
  await saveCatalogAttributeDefinition(owner, { ...definition, allowedValues: ["Blue", "Black", "Red"] });
  await saveCatalogAttributeDefinition(owner, { id: width, name: "Width", scope: "PRODUCT", dataType: "NUMBER" });
  await saveCatalogAttributeDefinition(owner, { id: washable, name: "Washable", scope: "VARIANT", dataType: "BOOLEAN" });
  for (const id of [width, washable, colour]) await setRule(otherLeaf, id, { ...defaults, required: true });
  const templates = await categoryAttributes(otherLeaf);
  const variant = { id: "blue", options: { [variantOptionKey]: "Blue" }, values: { [washable]: false } };
  const productValues = { [width]: 0, [material]: "Canvas" };
  assert.deepEqual(validateCategoryAttributeValues(templates, {
    productValues, variants: [variant, { id: "retired", active: false }],
  }), []);

  const issues = validateCategoryAttributeValues(templates, {
    productValues: { [width]: "0", [colour]: "Blue", [material]: "Canvas" },
    variants: [
      { id: "wrong", options: { [variantOptionKey]: "Green" }, values: { [width]: 3, [washable]: "false", [colour]: "Blue" } },
      { id: "missing" },
    ],
  });
  assert.equal(issues.length, 8);
  assert.ok(issues.some(issue => issue.attributeId === colour && !issue.variantId && issue.reason === "not_applicable"));
  assert.ok(issues.some(issue => issue.attributeId === width && !issue.variantId && issue.reason === "invalid_value"));
  assert.ok(issues.some(issue => issue.attributeId === colour && issue.variantId === "wrong" && issue.reason === "use_variant_option"));
  assert.ok(issues.some(issue => issue.attributeId === colour && issue.variantId === "wrong" && issue.reason === "invalid_value"));
  assert.ok(issues.some(issue => issue.attributeId === washable && issue.variantId === "wrong" && issue.reason === "invalid_value"));
  assert.equal(issues.filter(issue => issue.variantId === "missing" && issue.reason === "required").length, 2);
});
