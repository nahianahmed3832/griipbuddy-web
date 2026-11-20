import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import "../../scripts/load-env.ts";
import { compatibleVariantIds, resolveDeviceModel } from "../../src/lib/catalog/device-fitment.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { saveDeviceModel, saveVariantCompatibility } from "../../src/lib/staff/device-fitment.ts";
import { saveProductFoundation } from "../../src/lib/staff/product-foundation.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const nonce = randomUUID().slice(0, 8);
const prefix = `stage3-fit-${nonce}`;
const owner = `${prefix}-owner`;
const packer = `${prefix}-packer`;
const brand = `Fixture ${nonce}`;
const device = (id: string, name: string) => ({ id: `${prefix}-${id}`, brand, name, revision: null, aliases: [] as string[] });
const productId = `${prefix}-universal`;
const variantId = `v-${productId}`;
const departmentIds = [`${prefix}-dept`, `${prefix}-category`, `${prefix}-leaf`] as const;

before(async () => {
  await db.user.createMany({ data: [owner, packer].map(id => ({ id, name: "Fitment test staff", email: `${id}@example.test` })) });
  await db.staffAccess.createMany({ data: [{ userId: owner, role: "OWNER" }, { userId: packer, role: "PACKER" }] });
});

after(async () => {
  try {
    await db.variantCompatibility.deleteMany({ where: { variantId } });
    await db.marketOffer.deleteMany({ where: { variantId } });
    await db.inventory.deleteMany({ where: { variantId } });
    await db.variant.deleteMany({ where: { id: variantId } });
    await db.product.deleteMany({ where: { id: productId } });
    for (const id of [...departmentIds].reverse()) await db.department.deleteMany({ where: { id } });
    await db.deviceModelAlias.deleteMany({ where: { modelId: { startsWith: prefix } } });
    await db.deviceModel.deleteMany({ where: { id: { startsWith: prefix } } });
    await db.auditEvent.deleteMany({ where: { actorId: { in: [owner, packer] } } });
    await db.staffAccess.deleteMany({ where: { userId: { in: [owner, packer] } } });
    await db.user.deleteMany({ where: { id: { in: [owner, packer] } } });
  } finally {
    await db.$disconnect();
  }
});

test("approved aliases and canonical names share one exact lookup space", async () => {
  const input = { ...device("canonical-a", "Phone A"), aliases: [`${nonce} Model One`] };
  await assert.rejects(saveDeviceModel(packer, input), /permission/);
  assert.deepEqual(await saveDeviceModel(owner, input), { id: input.id, revision: 0 });
  assert.deepEqual(await resolveDeviceModel(`  Ｆｉｘｔｕｒｅ ${nonce} PHONE-A `, db), {
    id: input.id, brand, name: input.name,
  });
  assert.equal((await resolveDeviceModel(`${nonce} model   ONE`, db))?.id, input.id);
  assert.equal(await resolveDeviceModel(`${nonce} model`, db), null);
  await assert.rejects(saveDeviceModel(owner, { ...device("canonical-b", "Phone B"),
    aliases: [`${brand} PHONE A`] }), /belongs to another device model/);

  const canonical = device("race-canonical", "Phone C");
  const alias = { ...device("race-alias", "Phone D"), aliases: [`${brand} Phone C`] };
  const race = await Promise.allSettled([saveDeviceModel(owner, canonical), saveDeviceModel(owner, alias)]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String(race.find(result => result.status === "rejected")?.reason), /belongs to another device model/);

  await assert.rejects(saveDeviceModel(owner, { ...input, name: "Phone A Plus" }), /changed/);
  const renamed = await saveDeviceModel(owner, { ...input, name: "Phone A Plus", revision: 0, aliases: [`${brand} Phone A`] });
  assert.deepEqual(renamed, { id: input.id, revision: 1 });
  assert.equal((await resolveDeviceModel(`${brand} phone a`, db))?.id, input.id);
  assert.equal(await resolveDeviceModel(`${nonce} Model One`, db), null);
});

test("a universal accessory retains one SKU and stock pool across fitment links and markets", async () => {
  const [root, category, leaf] = departmentIds;
  const presentation = { name: "Test category", shortName: "Test", description: "", imageSrc: "/editorial/hero.webp",
    imageAlt: "Fixture", position: 0 };
  await db.department.create({ data: { id: root, slug: root, kind: "DEPARTMENT", ...presentation } });
  await db.department.create({ data: { id: category, slug: category, kind: "CATEGORY", parentId: root, ...presentation } });
  await db.department.create({ data: { id: leaf, slug: leaf, kind: "SUBCATEGORY", parentId: category, ...presentation } });
  const first = await saveDeviceModel(owner, device("stand-a", "Stand Test Phone A"));
  const second = await saveDeviceModel(owner, device("stand-b", "Stand Test Phone B"));
  await saveProductFoundation(owner, {
    id: productId, slug: productId, primaryCategoryId: leaf, expectedRevision: null, name: "Universal stand",
    description: "One stand that fits both fixture phones.", publication: "ACTIVE", options: [],
    variants: [{ id: variantId, sku: `STAGE3-STAND-${nonce.toUpperCase()}`, selections: {} }],
  });
  await db.inventory.create({ data: { variantId, available: 7 } });
  await db.marketOffer.createMany({ data: [
    { variantId, marketId: "bd", currency: "BDT", amountMinor: 99_000 },
    { variantId, marketId: "us", currency: "USD", amountMinor: 1499, eligible: false },
  ] });
  const input = { productId, variantId, modelIds: [first.id, second.id], revision: 0 };
  await assert.rejects(saveVariantCompatibility(packer, input), /permission/);
  await assert.rejects(saveVariantCompatibility(owner, { ...input, modelIds: [first.id, first.id] }), /model once/);
  await assert.rejects(saveVariantCompatibility(owner, { ...input, modelIds: [`${prefix}-unknown`] }), /approved device models/);
  await assert.rejects(saveVariantCompatibility(owner, { ...input, productId: `${prefix}-unrelated` }), /belongs to this product/);
  assert.deepEqual(await saveVariantCompatibility(owner, input), { ...input, revision: 1 });
  await assert.rejects(saveVariantCompatibility(owner, input), /product changed/i);
  assert.deepEqual(await saveVariantCompatibility(owner, { ...input, revision: 1 }), { ...input, revision: 1 });

  for (const model of [first, second]) {
    assert.deepEqual(await compatibleVariantIds(model.id, "bd", db), [variantId]);
    assert.deepEqual(await compatibleVariantIds(model.id, "us", db), []);
  }
  await db.marketOffer.update({ where: { variantId_marketId: { variantId, marketId: "us" } }, data: { eligible: true } });
  for (const model of [first, second]) assert.deepEqual(await compatibleVariantIds(model.id, "us", db), [variantId]);
  assert.equal(await db.product.count({ where: { id: productId } }), 1);
  assert.deepEqual(await db.variant.findMany({ where: { productId }, select: { id: true, sku: true } }), [
    { id: variantId, sku: `STAGE3-STAND-${nonce.toUpperCase()}` },
  ]);
  assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available, 7);
  assert.equal(await db.variantCompatibility.count({ where: { variantId } }), 2);

  const cleared = await saveVariantCompatibility(owner, { ...input, revision: 1, modelIds: [] });
  assert.equal(cleared.revision, 2);
  assert.deepEqual(await compatibleVariantIds(first.id, "bd", db), []);
  const restored = await saveVariantCompatibility(owner, { ...input, revision: cleared.revision });
  assert.deepEqual(await compatibleVariantIds(first.id, "bd", db), [variantId]);

  await db.product.update({ where: { id: productId }, data: { publication: "DRAFT", active: false } });
  await db.variant.update({ where: { id: variantId }, data: { active: false, isDefault: false, archivedAt: new Date() } });
  assert.deepEqual(await compatibleVariantIds(first.id, "bd", db), []);
  await assert.rejects(saveVariantCompatibility(owner, { ...input, revision: restored.revision }), /current foundation variant/);
  assert.equal(await db.variantCompatibility.count({ where: { variantId } }), 2);
});
