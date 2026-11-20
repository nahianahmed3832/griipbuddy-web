import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { catalogProductHref } from "../../src/lib/catalog/category-browse-links.ts";
import { listConnectedCatalog } from "../../src/lib/catalog/connected-listing.ts";
import type { CatalogReadContext } from "../../src/lib/catalog/connected-public.ts";
import { getConnectedProduct } from "../../src/lib/catalog/connected-product.ts";
import { readProductChoice } from "../../src/lib/catalog/product-choice.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { saveDeviceModel, saveVariantCompatibility } from "../../src/lib/staff/device-fitment.ts";
import { saveProductFoundation } from "../../src/lib/staff/product-foundation.ts";
import { saveCategory } from "../../src/lib/staff/taxonomy.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());
const bd = { marketId: "bd", locale: "en-BD" } satisfies CatalogReadContext;
const us = { marketId: "us", locale: "en-US" } satisfies CatalogReadContext;
const photo = { src: "/catalog/phone-stand.webp", alt: "Catalog search fixture" };

async function fixture(t: TestContext) {
  const prefix = `stage11-${randomUUID().slice(0, 8)}`;
  const brand = `${prefix} Lumen`;
  const parentId = `${prefix}-case`;
  const accessoryId = `${prefix}-mount`;
  const modelId = `${prefix}-pocket-17`;
  const plusId = `${modelId}-plus`;
  const attributeId = `${prefix}-thickness`;
  const alias = `${prefix} Pocket Seventeen`;
  const model = "Lumen Pocket 17";
  const modelPlus = `${model}+`;
  const owner = (await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" } })).userId;
  const actor = { kind: "staff", id: owner } as const;
  const scope = { startsWith: prefix };
  const variantScope = { startsWith: `v-${prefix}` };
  t.after(async () => {
    await db.marketOffer.deleteMany({ where: { variantId: variantScope } });
    await db.marketOfferIdentity.deleteMany({ where: { variantId: variantScope } });
    await db.variant.deleteMany({ where: { productId: scope } });
    await db.product.deleteMany({ where: { id: scope } });
    await db.deviceModelAlias.deleteMany({ where: { modelId: scope } });
    await db.deviceModel.deleteMany({ where: { id: scope } });
    await db.categoryAttributeTemplate.deleteMany({ where: { departmentId: scope } });
    await db.catalogAttributeDefinition.deleteMany({ where: { id: scope } });
    await db.departmentTranslation.deleteMany({ where: { departmentId: scope } });
    for (const kind of ["SUBCATEGORY", "CATEGORY", "DEPARTMENT"] as const) await db.department.deleteMany({ where: { kind, id: scope } });
    await db.auditEvent.deleteMany({ where: { OR: [{ target: scope }, { target: variantScope }] } });
  });
  const category = (suffix: string, name: string, kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY", parentId: string | null) => {
    const id = `${prefix}-${suffix}`;
    return saveCategory(owner, { id, slug: id, name, shortName: name, kind, parentId,
      description: "", state: "ACTIVE", position: 0, image: photo, revision: null });
  };
  const root = await category("devices", "Lumen Device Equipment", "DEPARTMENT", null);
  const cases = await category("cases", "Lumen Case Library", "CATEGORY", root.id);
  const leaf = await category("protective", "Lumen Protective Cases", "SUBCATEGORY", cases.id);
  const secondary = await category("travel", "Lumen Travel Equipment", "SUBCATEGORY", cases.id);
  await db.departmentTranslation.create({ data: { departmentId: root.id, locale: "bn-BD", slug: `${root.id}-bn`,
    name: "ভ্রমণ সরঞ্জাম", shortName: "ভ্রমণ সরঞ্জাম", description: "" } });
  await db.categoryAttributeTemplate.create({ data: { department: { connect: { id: leaf.id } }, filterable: true,
    attribute: { create: { id: attributeId, name: "Calibre", scope: "VARIANT", dataType: "NUMBER" } } } });
  const options = [
    { id: "model", key: "model", label: "Model", values: [{ id: "pocket-17", value: model, label: model },
      { id: "pocket-17-plus", value: modelPlus, label: modelPlus }] },
    { id: "design", key: "design", label: "Design", values: [{ id: "plain", value: "Plain", label: "Plain" },
      { id: "floral", value: "Floral", label: "Floral" }] },
    { id: "color", key: "color", label: "Colour", values: [{ id: "black", value: "Black", label: "Black" },
      { id: "blue", value: "Blue", label: "Blue" }] },
  ];
  const row = (suffix: string, selections: Record<string, string>, attributeValues?: Record<string, number>) => ({
    id: `v-${prefix}-${suffix}`, sku: `${prefix}-${suffix}`.toUpperCase(), selections, attributeValues,
  });
  const plain = row("standard", { model: "pocket-17", design: "plain", color: "black" }, { [attributeId]: 4 });
  const floral = row("fleur", { model: "pocket-17", design: "floral", color: "blue" }, { [attributeId]: 7 });
  const plus = row("plus", { model: "pocket-17-plus", design: "plain", color: "black" }, { [attributeId]: 8 });
  const universal = row("universal", {});
  const draft = row("draft", {});
  await saveProductFoundation(owner, { id: parentId, slug: parentId, name: "Lumen Protective Shell",
    description: `A fitted shell with Plain and Floral designs, Blue and Black, for ${model}, ${modelPlus}, and forthcoming Lumen Pocket 18 Pro.`,
    expectedRevision: null, primaryCategoryId: leaf.id, secondaryCategoryIds: [secondary.id], brand,
    publication: "ACTIVE", options, variants: [plain, floral, plus], defaultVariantId: plain.id });
  const simple = (id: string, variant: typeof universal, name: string, publication: "ACTIVE" | "DRAFT") => saveProductFoundation(owner, {
    id, slug: id, name, primaryCategoryId: secondary.id, expectedRevision: null, brand,
    description: "A shared universal accessory with a single physical SKU.", publication, options: [], variants: [variant],
  });
  await simple(accessoryId, universal, "Lumen Universal Mount", "ACTIVE");
  await simple(`${prefix}-draft`, draft, "Lumen Confidential Draft", "DRAFT");
  await db.productTranslation.create({ data: { productId: parentId, locale: "bn-BD", name: "সুরক্ষা আবরণ",
    description: "ফিক্সচারের বাংলা বিবরণ" } });
  await db.variant.update({ where: { id: floral.id }, data: { imageSrc: "/catalog/headphones-taupe.webp", imageAlt: "Blue floral sample",
    mpn: `${prefix}-TMP-502`, gtin: "036000291452" } });

  await saveDeviceModel(owner, { id: modelId, name: model, brand, aliases: [alias], revision: null });
  await saveDeviceModel(owner, { id: plusId, name: `${model} Plus`, brand, aliases: [modelPlus], revision: null });
  await saveVariantCompatibility(owner, { productId: accessoryId, variantId: universal.id, revision: 0, modelIds: [modelId, plusId] });
  // The case's model choices carry the same approved identities without claiming additional linked fitment.
  await db.marketplaceShop.upsert({ where: { id: storeShop.id }, update: {}, create: {
    ...storeShop, published: true, announcement: "", about: "",
  } });
  async function offer(variantId: string, marketId: "bd" | "us", amountMinor: number,
    expectedRevision: number | null = null, publication: "ACTIVE" | "DRAFT" = "ACTIVE") {
    return saveConnectedOffer(actor, { variantId, marketId, sellerId: storeShop.id, expectedRevision, amountMinor,
      publication, eligible: publication === "ACTIVE" });
  }
  for (const [index, variant] of [plain, floral, plus, universal, draft].entries()) {
    await offer(variant.id, "bd", 120000 + index * 10000);
    if (variant.id !== plus.id) await offer(variant.id, "us", 2000 + index * 500);
  }
  const read = (q: string, filters: Record<string, string> = {}, context: CatalogReadContext = bd, page = 1, suggest?: true) =>
    listConnectedCatalog(new URLSearchParams({ category: root.id, q, ...filters }), context, db, new Date(),
      { search: true, browsePage: page, suggest });
  return { read, offer, root, parentId, accessoryId, owner, brand, alias, model, modelPlus, modelId, plusId,
    plain, floral, plus, universal, draft, attributeId };
}

test("search matches approved model aliases on real variants, preserves ambiguity and rejects mismatched generations or sibling options", async t => {
  const f = await fixture(t);
  const exact = await f.read(f.floral.sku.toLowerCase(), {}, us);
  assert.equal(exact.total, 1);
  const [card] = exact.items;
  assert.equal(card.id, f.parentId);
  assert.equal(card.matchedVariantId, f.floral.id);
  assert.deepEqual(card.matchingVariantIds, [f.floral.id]);
  assert.deepEqual(card.searchMatch, { kind: "sku", label: f.floral.sku });
  assert.equal(card.representative.offer.amountMinor, 2500);
  assert.equal(card.representative.offer.currency, "USD");
  assert.ok(card.representative.offer.id);
  assert.equal(card.representative.image?.alt, "Blue floral sample");
  assert.match(catalogProductHref(card, { id: "us", locale: "en-US", regional: false }), new RegExp(`variant=${f.floral.id}`));
  assert.equal((await f.read(f.floral.sku, { design: "Plain" })).total, 0);
  assert.equal((await f.read("036000291452")).items[0].matchedVariantId, f.floral.id);

  const aliasSearch = await f.read(f.alias.replace(" Pocket", "--POCKET"), {}, bd, 1, true);
  assert.equal(aliasSearch.total, 2);
  const cases = aliasSearch.items.find(item => item.id === f.parentId)!;
  assert.deepEqual(cases.matchingVariantIds, [f.plain.id, f.floral.id]);
  assert.equal(cases.matchedVariantId, null);
  assert.deepEqual(cases.knownOptions.map(option => option.valueId), ["pocket-17"]);
  assert.deepEqual(aliasSearch.items.find(item => item.id === f.accessoryId)?.matchingVariantIds, [f.universal.id]);
  assert.ok(aliasSearch.suggestions?.models.some(item => item.id === f.modelId));
  const partialHref = catalogProductHref(cases, { id: "bd", locale: "en-BD", regional: false });
  const page = await getConnectedProduct(cases.slug, bd, undefined, db);
  assert.ok(page);
  const partial = readProductChoice(page.options, page.variants, new URL(partialHref, "http://localhost").searchParams);
  assert.deepEqual(partial.picks, { model: "pocket-17" });
  assert.equal(partial.selected, undefined);
  assert.deepEqual((await f.read(f.model, { model: f.modelId })).items.find(item => item.id === f.parentId)?.matchingVariantIds,
    [f.plain.id, f.floral.id]);

  const plus = await f.read(f.modelPlus);
  assert.deepEqual(plus.items.find(item => item.id === f.parentId)?.matchingVariantIds, [f.plus.id]);
  assert.equal((await f.read(f.modelPlus, {}, us)).items.some(item => item.id === f.parentId), false);
  assert.equal((await f.read("Lumen Pocket 18 Pro")).total, 0);
  assert.equal((await f.read(`${f.modelPlus} Floral`)).total, 0);
  assert.equal((await f.read(`${f.model} Floral`, { color: "Black" })).total, 0);
  assert.equal((await f.read(f.model, { model: "Lumen Pocket 66" })).total, 0);
  assert.deepEqual((await f.read(f.model, { design: "Floral", attribute: `${f.attributeId}:7` })).items[0].matchingVariantIds, [f.floral.id]);
  assert.equal((await f.read("Calibre 7")).items[0].matchedVariantId, f.floral.id);
  assert.equal((await f.read(f.draft.sku)).total, 0);
});

test("grouped pagination and facets use localized current records after authoring changes and retried reads", async t => {
  const f = await fixture(t);
  const local = { ...bd, locale: "bn-BD" };
  assert.equal((await f.read("সুরক্ষা আবরণ", {}, local)).items[0].name, "সুরক্ষা আবরণ");
  assert.equal((await f.read("ভ্রমণ সরঞ্জাম", {}, local)).total, 2);
  assert.ok((await f.read("Lumen Device", {}, bd, 1, true)).suggestions?.categories.some(category => category.id === f.root.id));
  const spelling = await f.read("Protectvie Shell");
  assert.equal(spelling.items[0].id, f.parentId);
  assert.equal(spelling.items[0].searchMatch?.kind, "spelling");
  assert.equal((await f.read("Protectvie Shlel")).total, 0);
  const filter = { limit: "1", sort: "price-low" };
  const first = await f.read(f.model, filter);
  const second = await f.read(f.model, filter, bd, 2);
  assert.equal(first.total, 2);
  assert.equal(second.total, first.total);
  assert.equal(second.browse?.page, 2);
  assert.equal(second.browse?.pageCount, 2);
  assert.deepEqual(second.facets, first.facets);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(first.facets.model.find(choice => choice.value === f.modelId)?.count, 2);

  const offer = await f.offer(f.floral.id, "us", 2777, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const [record] = (await f.read(f.floral.sku, {}, us)).items;
    assert.deepEqual([record.representative.offer.id, record.representative.offer.amountMinor], [offer.id, 2777]);
  }
  await f.offer(f.floral.id, "us", 2777, 1, "DRAFT");
  assert.equal((await f.read(f.floral.sku, {}, us)).total, 0);
  assert.equal((await f.read(f.floral.sku, {}, bd)).total, 1);
  const newAlias = `${f.alias} Approved`;
  await saveDeviceModel(f.owner, { id: f.modelId, name: f.model, brand: f.brand, aliases: [newAlias], revision: 0 });
  assert.equal((await f.read(f.alias)).total, 0);
  assert.equal((await f.read(newAlias)).total, 2);
  await saveVariantCompatibility(f.owner, { productId: f.accessoryId, variantId: f.universal.id, revision: 1, modelIds: [f.plusId] });
  assert.deepEqual((await f.read(newAlias)).items.map(item => item.id), [f.parentId]);
  assert.deepEqual((await f.read(f.modelPlus, {}, us)).items.map(item => item.id), [f.accessoryId]);
  await db.product.update({ where: { id: f.accessoryId }, data: { publication: "ARCHIVED" } });
  assert.equal((await f.read(f.modelPlus, {}, us)).total, 0);
});
