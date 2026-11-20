import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { connectedCollectionProductFilter } from "../../src/lib/catalog/collection-selection.ts";
import { getMarketProductFoundation, resolveProductVariant } from "../../src/lib/catalog/product-foundation.ts";
import { catalog, listCategoryProductIds } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveCategoryAttributeTemplate, saveCatalogAttributeDefinition } from "../../src/lib/staff/category-attributes.ts";
import { saveProductCategoryAssignments } from "../../src/lib/staff/category-assignments.ts";
import { catalogProduct, saveProduct } from "../../src/lib/staff/catalog.ts";
import { ownerProductFoundation, saveProductFoundation } from "../../src/lib/staff/product-foundation.ts";
import { saveCategory } from "../../src/lib/staff/taxonomy.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function fixture(t: TestContext) {
  const prefix = `stage3-foundation-${randomUUID().slice(0, 8)}`;
  const owner = (await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" } })).userId;
  const attempts: string[] = [];
  const referenced = { startsWith: prefix };
  t.after(async () => {
    await db.orderItem.deleteMany({ where: { order: { reference: referenced } } });
    await db.order.deleteMany({ where: { reference: referenced } });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } });
    await db.marketOffer.deleteMany({ where: { variant: { productId: referenced } } });
    await db.inventory.deleteMany({ where: { variant: { productId: referenced } } });
    await db.variant.deleteMany({ where: { productId: referenced } });
    await db.product.deleteMany({ where: { id: referenced } });
    await db.categoryAttributeTemplate.deleteMany({ where: { departmentId: referenced } });
    await db.catalogAttributeDefinition.deleteMany({ where: { id: referenced } });
    for (const kind of ["SUBCATEGORY", "CATEGORY", "DEPARTMENT"] as const) {
      await db.department.deleteMany({ where: { id: referenced, kind } });
    }
    await db.auditEvent.deleteMany({ where: { target: referenced } });
  });
  async function category(suffix: string, kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY", parentId: string | null) {
    const id = `${prefix}-${suffix}`;
    return saveCategory(owner, {
      id, slug: id, name: suffix, shortName: suffix, description: "", state: "ACTIVE", position: 0,
      image: { src: "/catalog/phone-stand.webp", alt: "Fixture" }, kind, parentId, revision: null,
    });
  }
  const root = await category("tech", "DEPARTMENT", null);
  const cases = await category("cases", "CATEGORY", root.id);
  const accessories = await category("accessories", "CATEGORY", root.id);
  const protective = await category("protective", "SUBCATEGORY", cases.id);
  const travel = await category("travel", "SUBCATEGORY", accessories.id);
  function row(suffix: string, selections: Record<string, string>) {
    return { id: `v-${prefix}-${suffix}`, sku: `${prefix}-${suffix}`.toUpperCase(), active: true, selections };
  }
  function simple(suffix: string) {
    const id = `${prefix}-${suffix}`;
    return {
      id, slug: id, name: "Cleaning wipes", brand: "Synthetic", description: "A single optionless fixture product.",
      primaryCategoryId: travel.id, expectedRevision: null, publication: "ACTIVE", options: [], variants: [row(suffix, {})],
    };
  }
  const protectiveCase = {
    ...simple("case"), name: "Protective case", description: "A shared protective case in three manufactured configurations.",
    primaryCategoryId: protective.id, secondaryCategoryIds: [travel.id], specifications: [{ label: "Care", value: "Wipe clean" }],
    options: [
      { id: "model", key: "Model", label: "Model", values: [{ id: "phone-a", value: "Phone A", label: "Phone A" }, { id: "phone-b", value: "Phone B", label: "Phone B" }] },
      { id: "design", key: "Design", label: "Design", values: [{ id: "plain", value: "Plain", label: "Plain" }, { id: "floral", value: "Floral", label: "Floral" }] },
      { id: "color", key: "Color", label: "Colour", values: [{ id: "black", value: "Black", label: "Black" }, { id: "blue", value: "Blue", label: "Blue" }] },
    ],
    variants: [
      row("a-plain-black", { model: "phone-a", design: "plain", color: "black" }),
      row("a-floral-blue", { model: "phone-a", design: "floral", color: "blue" }),
      row("b-plain-black", { model: "phone-b", design: "plain", color: "black" }),
    ],
    defaultVariantId: `v-${prefix}-a-plain-black`,
  };
  async function offer(variantId: string) {
    await db.marketOffer.createMany({ data: [
      { variantId, marketId: "bd", currency: "BDT", amountMinor: 129_000 },
      { variantId, marketId: "us", currency: "USD", amountMinor: 1999 },
    ] });
  }
  async function purchased(variant: { id: string; sku: string }) {
    const attemptId = randomUUID();
    attempts.push(attemptId);
    return db.order.create({
      data: {
        attempt: { create: { id: attemptId, guestKey: "fixture", requestHash: "fixture" } },
        reference: `${prefix}-purchase`, marketId: "bd", currency: "BDT", commerceEvidence: "fixture",
        customerName: "Synthetic", phone: "01700000000", district: "dhaka", districtLabel: "Dhaka",
        locality: "Fixture", address: "Fixture address", deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax",
        subtotalMinor: 129_000, discountMinor: 100, deliveryMinor: 0, taxMinor: 0, totalMinor: 128_900,
        items: { create: { variantId: variant.id, sku: variant.sku, productName: "Purchased case", variantName: "Phone A / Plain / Black",
          quantity: 1, currency: "BDT", unitPriceMinor: 129_000, unitDiscountMinor: 100, lineTotalMinor: 128_900 } },
      }, select: { id: true },
    });
  }
  return { owner, prefix, root, cases, accessories, protective, travel, row, simple, protectiveCase, offer, purchased };
}

test("connected product rules persist across omitted flags and invalidate stale edits", async t => {
  const { owner, simple } = await fixture(t);
  const input = simple("collection-rules");
  const created = await saveProductFoundation(owner, { ...input, featured: true, newArrival: true });
  const where = (selection: "FEATURED" | "NEW") => ({
    id: input.id, ...connectedCollectionProductFilter({ id: "fixture-collection", selection }),
  });
  for (const selection of ["FEATURED", "NEW"] as const) assert.equal(await db.product.count({ where: where(selection) }), 1);
  const edited = await saveProductFoundation(owner, { ...input, name: "Updated without merchandising flags", expectedRevision: created.revision });
  const retained = await ownerProductFoundation(owner, input.id);
  assert.equal(retained?.featured, true);
  assert.equal(retained?.newArrival, true);
  await assert.rejects(saveProductFoundation(owner, { ...input, featured: false, expectedRevision: created.revision }), /Reload before saving/);
  await saveProductFoundation(owner, { ...input, featured: false, expectedRevision: edited.revision });
  assert.equal(await db.product.count({ where: where("FEATURED") }), 0);
  assert.equal(await db.product.count({ where: where("NEW") }), 1);
});

test("only explicit case tuples qualify, and both category branches reach the same product", async t => {
  const { owner, protectiveCase: input, simple, row, root, cases, accessories, offer } = await fixture(t);
  const [first, second, third] = input.variants;
  await assert.rejects(saveProductFoundation(owner, {
    ...input, variants: [first, { ...second, selections: { color: "black", design: "plain", model: "phone-a" } }, third],
  }), /different option combination/);
  await assert.rejects(saveProductFoundation(owner, {
    ...input, variants: [...input.variants, row("phantom", { model: "phone-b", design: "floral", color: "blue" })]
      .map(variant => variant.id.endsWith("phantom") ? { ...variant, active: false } : variant),
  }), /explicitly enabled/);
  const foreign = simple("foreign");
  await saveProductFoundation(owner, { ...foreign, defaultVariantId: foreign.variants[0].id,
    options: [{ id: "foreign-color", key: "Color", label: "Colour", values: [{ id: "remote-red", value: "Red", label: "Red" }] }],
    variants: [{ ...foreign.variants[0], selections: { "foreign-color": "remote-red" } }],
  });
  await assert.rejects(saveProductFoundation(owner, {
    ...input, variants: [{ ...first, selections: { ...first.selections, color: "remote-red" } }, second, third],
  }), /from each option of this product/);
  assert.equal(await db.product.count({ where: { id: input.id } }), 0);

  await saveProductFoundation(owner, input);
  assert.equal(await db.marketOffer.count({ where: { variant: { productId: input.id } } }), 0);
  assert.equal(await db.inventory.count({ where: { variant: { productId: input.id } } }), 0);
  await assert.rejects(db.variantOptionSelection.create({ data: {
    variantId: first.id, productId: foreign.id, optionId: "foreign-color", optionValueId: "remote-red",
  } }), /foreign key constraint/i);
  const signature = (await db.variant.findUniqueOrThrow({ where: { id: first.id } })).optionSignature;
  await assert.rejects(db.variant.create({ data: { id: `${first.id}-duplicate`, sku: `${first.sku}-COPY`,
    productId: input.id, options: {}, optionSignature: signature, label: "Duplicate", position: 9 } }), /unique constraint/i);

  await offer(first.id);
  await offer(second.id);
  await db.marketOffer.create({ data: { variantId: third.id, marketId: "bd", currency: "BDT", amountMinor: 149_000 } });
  for (const id of [root.id, cases.id, accessories.id]) assert.deepEqual(await listCategoryProductIds(id, "bd"), [input.id]);
  assert.equal(await resolveProductVariant(input.id, { model: "phone-b", design: "floral", color: "blue" }, "bd"), null);
  assert.equal(await resolveProductVariant(input.id, { model: "phone-a", color: "blue" }, "bd"), null);
  assert.equal(await resolveProductVariant(input.id, third.selections, "us"), null);
  assert.deepEqual(await resolveProductVariant(input.id, { color: "blue", design: "floral", model: "phone-a" }, "us"),
    { id: second.id, productId: input.id, sku: second.sku });
  const browse = await getMarketProductFoundation(input.id, "bd", "en-BD");
  assert.deepEqual(browse?.variants.map(variant => variant.id), input.variants.map(variant => variant.id));
  assert.equal(browse?.defaultVariantId, first.id);
  assert.deepEqual(browse?.secondaryCategoryIds, input.secondaryCategoryIds);
  assert.equal((await catalog.getProduct(input.slug, "us"))?.id, input.id);
});

test("category templates validate typed attributes and one canonical source for bound option values", async t => {
  const { owner, protectiveCase: input, protective, travel, prefix, offer } = await fixture(t);
  const weight = `${prefix}-weight`;
  const shade = `${prefix}-shade`;
  const matte = `${prefix}-matte`;
  await saveCatalogAttributeDefinition(owner, { id: weight, name: "Weight", scope: "PRODUCT", dataType: "NUMBER" });
  await saveCatalogAttributeDefinition(owner, { id: shade, name: "Shade", scope: "VARIANT", dataType: "ENUM",
    variantOptionKey: "Color", allowedValues: ["Black", "Blue"] });
  await saveCatalogAttributeDefinition(owner, { id: matte, name: "Matte", scope: "VARIANT", dataType: "BOOLEAN" });
  for (const [expectedRevision, attributeId] of [weight, shade, matte].entries()) {
    await saveCategoryAttributeTemplate(owner, { departmentId: protective.id, attributeId, expectedRevision,
      template: { required: true, filterable: true, position: expectedRevision } });
  }
  const variants = input.variants.map(variant => ({ ...variant, attributeValues: { [matte]: false } }));
  await assert.rejects(saveProductFoundation(owner, { ...input, variants }), /weight \(required\)/);
  await assert.rejects(saveProductFoundation(owner, { ...input, variants, attributeValues: { [weight]: "42" } }), /weight \(invalid value\)/);
  await assert.rejects(saveProductFoundation(owner, { ...input, attributeValues: { [weight]: 42 },
    variants: variants.map(variant => ({ ...variant, attributeValues: { [matte]: false, [shade]: "Black" } })),
  }), /shade \(use variant option\)/);
  await saveProductFoundation(owner, { ...input, variants, attributeValues: { [weight]: 42 } });
  await offer(variants[0].id);
  const result = await getMarketProductFoundation(input.id, "bd", "en-BD");
  assert.deepEqual(result?.attributeValues, { [weight]: 42 });
  assert.deepEqual(result?.variants[0].attributeValues, { [matte]: false });
  const options = input.options.map(option => option.id !== "color" ? option : {
    ...option, values: option.values.map(value => value.id === "black" ? { ...value, label: "Midnight" } : value),
  });
  await saveProductFoundation(owner, { ...input, options, variants, expectedRevision: 0 });
  assert.equal((await resolveProductVariant(input.id, variants[0].selections, "bd"))?.id, variants[0].id);
  await assert.rejects(saveProductCategoryAssignments(owner, {
    productId: input.id, revision: 1, primaryCategoryId: travel.id, secondaryCategoryIds: [protective.id],
  }), /validate attributes/);
});

test("option labels can change and retirement keeps the purchased variant and amounts", async t => {
  const { owner, protectiveCase: input, purchased, offer } = await fixture(t);
  const [original, replacement] = input.variants;
  await saveProductFoundation(owner, input);
  for (const variant of input.variants) await offer(variant.id);
  await db.inventory.create({ data: { variantId: original.id, available: 7 } });
  const order = await purchased(original);
  const options = input.options.map(option => option.id !== "color" ? option : {
    ...option, label: "Finish colour", values: option.values.map(value => value.id === "black" ? { ...value, label: "Midnight" } : value),
  });
  const renamed = await saveProductFoundation(owner, { ...input, options, expectedRevision: 0 });
  assert.equal((await resolveProductVariant(input.id, original.selections, "bd"))?.id, original.id);
  const legacyReader = await catalog.getProduct(input.slug, "bd");
  assert.equal(legacyReader?.variants.find(variant => variant.id === original.id)?.options.Color, "Midnight");
  const legacyForm = await catalogProduct(db, input.id);
  await assert.rejects(saveProduct(owner, legacyForm?.product, renamed.revision, "editor"), /structured catalog product/);
  await assert.rejects(saveProductFoundation(owner, { ...input, options, expectedRevision: renamed.revision,
    variants: input.variants.map(variant => variant.id === original.id ? { ...variant, sku: "DIFFERENT" } : variant),
  }), /keeps its SKU and option combination/);
  const retired = await saveProductFoundation(owner, { ...input, options, expectedRevision: renamed.revision,
    defaultVariantId: replacement.id, variants: input.variants.map(variant => variant.id === original.id ? { ...variant, active: false } : variant),
  });
  assert.equal(await resolveProductVariant(input.id, original.selections, "bd"), null);
  const archived = await db.variant.findUniqueOrThrow({ where: { id: original.id }, include: { inventory: true, offers: true } });
  assert.equal(archived.sku, original.sku);
  assert.ok(archived.archivedAt);
  assert.equal(archived.inventory?.available, 7);
  assert.equal(archived.offers.length, 2);
  assert.equal((await getMarketProductFoundation(input.id, "bd", "en-BD"))?.defaultVariantId, replacement.id);
  const line = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  assert.deepEqual([line.variantId, line.sku, line.variantName, line.currency, line.unitPriceMinor, line.lineTotalMinor],
    [original.id, original.sku, "Phone A / Plain / Black", "BDT", 129_000, 128_900]);
  await assert.rejects(saveProductFoundation(owner, { ...input, options, expectedRevision: retired.revision }), /cannot be reactivated/);
});

test("simple products have one default and cannot reuse an issued SKU", async t => {
  const { owner, simple, offer } = await fixture(t);
  const input = simple("wipes");
  const [variant] = input.variants;
  await saveProductFoundation(owner, input);
  const authored = await ownerProductFoundation(owner, input.id);
  assert.equal(authored?.variants[0].id, variant.id);
  assert.deepEqual(authored?.variants[0].optionSelections, []);
  assert.equal(await getMarketProductFoundation(input.id, "bd", "en-BD"), null);
  const packer = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "PACKER" } });
  await assert.rejects(ownerProductFoundation(packer.userId, input.id), /permission/);
  await offer(variant.id);
  const row = await db.variant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(row.optionSignature, "[]");
  assert.equal(row.isDefault, true);
  assert.equal((await getMarketProductFoundation(input.id, "us", "en-US"))?.defaultVariantId, variant.id);
  assert.deepEqual(await resolveProductVariant(input.id, {}, "us"), { id: variant.id, sku: variant.sku, productId: input.id });
  assert.equal(await resolveProductVariant(input.id, { color: "blue" }, "us"), null);
  const clone = simple("clone");
  await assert.rejects(saveProductFoundation(owner, {
    ...clone, variants: [{ ...clone.variants[0], sku: variant.sku.toLowerCase() }],
  }), /SKU already belongs/);
  assert.equal(await db.product.count({ where: { id: clone.id } }), 0);
});
