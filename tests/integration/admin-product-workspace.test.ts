import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import "../../scripts/load-env.ts";
import { getConnectedProduct } from "../../src/lib/catalog/connected-product.ts";
import { getOfferFulfilment } from "../../src/lib/commerce/offer-fulfilment.ts";
import { guestOrder } from "../../src/lib/commerce/orders.ts";
import { initializeInventoryPool, recordStockMovement, saveWarehouseService } from "../../src/lib/commerce/physical-inventory.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { saveCatalogAttributeDefinition, saveCategoryAttributeTemplate } from "../../src/lib/staff/category-attributes.ts";
import { saveDeviceModel, saveVariantCompatibility } from "../../src/lib/staff/device-fitment.ts";
import { saveProductFoundation } from "../../src/lib/staff/product-foundation.ts";
import { saveProductGallery, saveProductTranslation } from "../../src/lib/staff/product-presentation.ts";
import { productPublicationReadiness, saveWorkspaceOffer, setWorkspaceProductPublication } from "../../src/lib/staff/product-publication.ts";
import { listProductWorkspace, productWorkspaceHistory } from "../../src/lib/staff/product-workspace.ts";
import { saveCategory } from "../../src/lib/staff/taxonomy.ts";
import { createMigrationHistoryFixture } from "./catalog-migration-history-fixture.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function workspace(t: TestContext) {
  const prefix = `stage8-${randomUUID().slice(0, 8)}`;
  const owner = (await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" } })).userId;
  const packer = (await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "PACKER" } })).userId;
  const root = `${prefix}-devices`;
  const branch = `${prefix}-accessories`;
  const leaf = `${prefix}-cases`;
  const other = `${prefix}-travel`;
  const warehouse = `${prefix}-warehouse`;
  const method = `${prefix}-ground`;
  const policies = await db.checkoutPolicy.findMany({ where: { marketId: { in: ["bd", "us"] } } });
  const previousOptions = process.env.GRIIP_MARKET_CONFIGURATION;
  const scopeSku = `v-${prefix}`;
  const image = { src: "/catalog/phone-stand.webp", alt: "Fixture product" };
  const actor = { id: owner, kind: "staff" } as const;

  t.after(async () => {
    if (previousOptions === undefined) delete process.env.GRIIP_MARKET_CONFIGURATION;
    else process.env.GRIIP_MARKET_CONFIGURATION = previousOptions;
    await db.$transaction(async tx => {
      await tx.auditEvent.deleteMany({ where: { OR: [{ target: { startsWith: prefix } }, { target: { startsWith: scopeSku } }] } });
      await tx.inventoryMovement.deleteMany({ where: { pool: { variantId: { startsWith: scopeSku } } } });
      await tx.inventoryPool.deleteMany({ where: { variantId: { startsWith: scopeSku } } });
      await tx.marketOffer.deleteMany({ where: { variantId: { startsWith: scopeSku } } });
      await tx.marketOfferIdentity.deleteMany({ where: { variantId: { startsWith: scopeSku } } });
      await tx.variant.deleteMany({ where: { id: { startsWith: scopeSku } } });
      await tx.product.deleteMany({ where: { id: { startsWith: prefix } } });
      await tx.deviceModelAlias.deleteMany({ where: { modelId: { startsWith: prefix } } });
      await tx.deviceModel.deleteMany({ where: { id: { startsWith: prefix } } });
      await tx.categoryAttributeTemplate.deleteMany({ where: { departmentId: { startsWith: prefix } } });
      await tx.catalogAttributeDefinition.deleteMany({ where: { id: { startsWith: prefix } } });
      for (const id of [other, leaf, branch, root]) await tx.department.deleteMany({ where: { id } });
      await tx.dispatchLocationMarket.deleteMany({ where: { locationId: warehouse } });
      await tx.dispatchLocation.deleteMany({ where: { id: warehouse } });
      await tx.deliveryZone.deleteMany({ where: { method } });
      for (const row of policies) await tx.checkoutPolicy.update({ where: { marketId: row.marketId },
        data: { enabled: row.enabled, codEnabled: row.codEnabled, taxTreatment: row.taxTreatment,
          taxBasisPoints: row.taxBasisPoints, taxLabel: row.taxLabel } });
    }, { timeout: 20_000 });
  });
  process.env.GRIIP_MARKET_CONFIGURATION = JSON.stringify({ us: {
    delivery: { coverage: "checkout-policy" },
    pricing: { priceList: "us-retail", taxTreatment: "MERCHANDISE_RATE", rounding: "minor-half-up" },
    payments: [{ method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true }],
  } });
  for (const [marketId, district] of [["bd", "dhaka"], ["us", "wa"]] as const) {
    await db.checkoutPolicy.update({ where: { marketId }, data: {
      enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 0, taxLabel: "Fixture tax",
    } });
    await db.deliveryZone.create({ data: { marketId, district, districtLabel: district, method, label: "Local route", chargeMinor: 0 } });
  }
  await db.dispatchLocation.create({ data: { id: warehouse, name: "Shared test warehouse", marketId: "bd" } });
  for (const marketId of ["bd", "us"] as const) await saveWarehouseService(actor, { locationId: warehouse, marketId,
    active: true, priority: 10, methods: [method] });
  for (const [id, kind, parentId] of [[root, "DEPARTMENT", null], [branch, "CATEGORY", root], [leaf, "SUBCATEGORY", branch],
    [other, "SUBCATEGORY", branch]] as const) await saveCategory(owner, {
    id, kind, parentId, slug: id, name: "Workspace category", shortName: "Workspace", description: "Fixture", position: 20,
    revision: null, state: "ACTIVE", image,
  });
  const magnetic = `${prefix}-magnetic`;
  await saveCatalogAttributeDefinition(owner, { id: magnetic, name: "Magnetic mount", scope: "PRODUCT", dataType: "BOOLEAN" });
  await saveCategoryAttributeTemplate(owner, { attributeId: magnetic, departmentId: branch, expectedRevision: 0,
    template: { required: true, filterable: true, position: 3, inheritable: true } });
  const simpleInput = (suffix: string) => {
    const id = `${prefix}-${suffix}`;
    return {
      id, slug: id, name: "Workspace protective gear", description: "Physical catalog workspace test.",
      primaryCategoryId: leaf, secondaryCategoryIds: [other], expectedRevision: null as number | null,
      publication: "DRAFT", attributeValues: { [magnetic]: true },
    };
  };
  return { prefix, owner, packer, actor, leaf, other, method, warehouse, image, simpleInput };
}

test("connected workspace publishes only explicit variants and uses one audited stock pool in both markets", async t => {
  const f = await workspace(t);
  const shared = f.simpleInput("multi");
  const options = [
    { id: "model", key: "Model", label: "Model",
      values: ["Phone A", "Phone B"].map((label, index) => ({ id: `phone-${index}`, label, value: label })) },
    { id: "design", key: "Design", label: "Design",
      values: ["Plain", "Floral"].map((label, index) => ({ id: `design-${index}`, label, value: label })) },
  ];
  const variants = [[0, 0], [0, 1], [1, 0]].map(([model, design], index) => ({
    id: `v-${shared.id}-${index}`, sku: `${shared.id.toUpperCase()}-${index}`, selections: { model: `phone-${model}`, design: `design-${design}` },
    active: true,
  }));
  const draftInput = { ...shared, options, variants, defaultVariantId: variants[0].id };
  const draft = await saveProductFoundation(f.owner, draftInput);
  assert.equal((await listProductWorkspace(f.owner, { q: shared.id, source: "connected", state: "DRAFT", page: 1 }))?.rows[0].incomplete, true);
  await assert.rejects(setWorkspaceProductPublication(f.owner, { productId: shared.id, revision: draft.revision }),
    /approved shared image/);
  await assert.rejects(saveProductFoundation(f.owner, { ...draftInput, id: `${f.prefix}-duplicate`, slug: `${f.prefix}-duplicate`,
    variants: variants.map(row => ({ ...row, id: row.id + "-copy" })), defaultVariantId: variants[0].id + "-copy" }), /variant ID or SKU/);
  await assert.rejects(saveProductFoundation(f.owner, { ...draftInput, expectedRevision: draft.revision,
    variants: variants.map((row, index) => index ? row : { ...row, selections: { model: "unregistered", design: "design-0" } }) }),
  /value from each option/);
  let revision = (await saveProductGallery(f.owner, { productId: shared.id, revision: draft.revision, images: [f.image] })).revision;
  revision = (await saveProductGallery(f.owner, { productId: shared.id, revision, variantId: variants[1].id, images: [
    { src: "/catalog/headphones-taupe.webp", alt: "Floral finish" },
  ] })).revision;
  revision = (await saveProductTranslation(f.owner, { productId: shared.id, revision, locale: "en-US",
    content: { name: "US protective gear", description: "US localized field." } })).revision;
  assert.equal((await productPublicationReadiness(db, shared.id))?.ready, false);

  const firstOffer = { variantId: variants[0].id, marketId: "bd", sellerId: storeShop.id, amountMinor: 129900,
    currency: "BDT", publication: "ACTIVE", eligible: true, expectedRevision: null };
  await assert.rejects(saveWorkspaceOffer(f.actor, firstOffer), /warehouse pool/);
  const pools = [];
  for (const variant of variants) {
    pools.push(await initializeInventoryPool(f.actor, { variantId: variant.id, locationId: f.warehouse }));
    await saveWorkspaceOffer(f.actor, { ...firstOffer, variantId: variant.id });
  }
  await saveWorkspaceOffer(f.actor, { ...firstOffer, marketId: "us", currency: "USD", amountMinor: 2399 });
  assert.equal((await productPublicationReadiness(db, shared.id))?.ready, true);
  const live = await setWorkspaceProductPublication(f.owner, { productId: shared.id, revision });
  assert.equal(live.publication, "ACTIVE");
  assert.equal(pools.every(pool => pool.onHand === 0), true);

  const movement = { poolId: pools[0].id, kind: "RECEIPT", quantity: 5, idempotencyKey: "workspace-receipt",
    reason: "Fixture stock count", reference: "fixture-inbound" };
  assert.equal((await recordStockMovement(f.actor, movement)).replayed, false);
  assert.equal((await recordStockMovement(f.actor, movement)).replayed, true);
  assert.equal(await db.inventoryMovement.count({ where: { poolId: pools[0].id } }), 1);
  for (const [marketId, country, district, postalCode] of [["bd", "BD", "dhaka", undefined], ["us", "US", "wa", "98101"]] as const) {
    const availability = await getOfferFulfilment({ variantId: variants[0].id, marketId,
      delivery: { destination: { country, district, postalCode, method: f.method }, paymentMethod: "COD", quantity: 5 } });
    assert.equal(availability.kind, "available");
    assert.equal(availability.offer.amountMinor, marketId === "bd" ? 129900 : 2399);
    assert.equal(availability.available, 5);
  }
  assert.equal(await db.inventoryPool.count({ where: { variantId: variants[0].id } }), 1);
  const detail = await getConnectedProduct(shared.id, { marketId: "bd", locale: "en-BD" }, variants[1].id);
  assert.equal(detail?.variants.length, 3);
  assert.equal(detail?.variants.some(row => row.options.some(pick => pick.value === "Phone B") &&
    row.options.some(pick => pick.value === "Floral")), false);
  assert.equal(detail?.variants.find(row => row.id === variants[1].id)?.image?.alt, "Floral finish");
  assert.deepEqual(detail?.product.secondaryCategoryIds, [f.other]);
  assert.equal((await getConnectedProduct(shared.id, { marketId: "us", locale: "en-US" }))?.product.name, "US protective gear");

  await assert.rejects(saveWorkspaceOffer({ kind: "staff", id: f.packer }, {
    ...firstOffer, expectedRevision: 0, amountMinor: 999,
  }), { code: "forbidden" });
  const valid = await saveWorkspaceOffer(f.actor, { ...firstOffer, expectedRevision: 0, amountMinor: 139900 });
  await assert.rejects(saveWorkspaceOffer(f.actor, { ...firstOffer, expectedRevision: 0, amountMinor: 149900 }), { code: "conflict" });
  assert.equal((await db.marketOffer.findUniqueOrThrow({ where: { variantId_marketId: { variantId: variants[0].id, marketId: "bd" } } })).amountMinor,
    valid.amountMinor);

  const history = await createMigrationHistoryFixture(db, { key: f.prefix, productId: shared.id,
    variantId: variants[1].id, sku: variants[1].sku, slug: shared.slug });
  try {
    const before = await guestOrder(history.orderId, null, history.shopperId);
    const archive = await saveProductFoundation(f.owner, { ...draftInput, expectedRevision: live.revision, publication: "ACTIVE",
      name: "Workspace protective gear revised",
      options: [...options].reverse().map(option => ({ ...option, label: `${option.label} label` })),
      variants: variants.map((variant, index) => ({ ...variant, active: index !== 1 })) });
    assert.equal((await db.variant.findUniqueOrThrow({ where: { id: variants[1].id } })).sku, variants[1].sku);
    assert.equal((await db.variant.findUniqueOrThrow({ where: { id: variants[1].id } })).active, false);
    assert.deepEqual(await guestOrder(history.orderId, null, history.shopperId), before);
    await assert.rejects(setWorkspaceProductPublication(f.owner, { productId: shared.id, revision: archive.revision - 1 }),
      { code: "conflict" });
    const events = await productWorkspaceHistory(f.owner, shared.id, variants.map(row => row.id));
    assert.ok(events.some(row => row.label === "Product saved" && row.fields === "Title"));
    assert.ok(events.some(row => row.label === "Product publication changed"));
    assert.ok(events.some(row => row.label === "Market offer updated"));
    assert.ok(events.some(row => row.label === "Stock receipt (+5)"));
  } finally {
    await history.cleanup();
  }
});

test("a simple universal product retains one default variant and several device aliases", async t => {
  const f = await workspace(t);
  const draftInput = f.simpleInput("universal");
  const variant = { id: `v-${draftInput.id}`, sku: draftInput.id.toUpperCase(), selections: {} };
  const draft = await saveProductFoundation(f.owner, { ...draftInput, options: [], variants: [variant] });
  for (const [index, name] of ["Phone A", "Phone B"].entries()) await saveDeviceModel(f.owner, {
    id: `${f.prefix}-phone-${index}`, brand: `Fixture ${f.prefix}`, name, aliases: [`${f.prefix} model ${index}`], revision: null,
  });
  await saveVariantCompatibility(f.owner, { productId: draft.id, variantId: variant.id, revision: draft.revision,
    modelIds: [`${f.prefix}-phone-0`, `${f.prefix}-phone-1`] });
  const row = await db.variant.findUniqueOrThrow({ where: { id: variant.id }, include: { compatibility: true } });
  assert.equal(row.isDefault, true);
  assert.equal(row.compatibility.length, 2);
  assert.equal(await db.variant.count({ where: { productId: draft.id } }), 1);
});
