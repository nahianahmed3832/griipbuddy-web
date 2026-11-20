import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import sharp from "sharp";
import "../../scripts/load-env.ts";
import { selectCatalogImage, selectProductContent } from "../../src/lib/catalog/product-presentation.ts";
import { availableMarketMedia, catalog } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeCatalogImage } from "../../src/lib/staff/catalog-media.ts";
import { saveProductGallery, saveProductTranslation } from "../../src/lib/staff/product-presentation.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function fixture(t: TestContext) {
  const prefix = `presentation-${randomBytes(8).toString("hex")}`;
  const ownerId = `${prefix}-owner`;
  const packerId = `${prefix}-packer`;
  const productId = `${prefix}-product`;
  const legacyId = `${prefix}-legacy`;
  const variantId = `v-${prefix}`;
  const foreignVariantId = `v-${prefix}-foreign`;
  const paths = new Set<string>();
  const parent = { id: { in: [productId, legacyId] } };
  t.after(async () => {
    await db.$transaction([
      db.auditEvent.deleteMany({ where: { actorId: { in: [ownerId, packerId] } } }),
      db.marketOffer.deleteMany({ where: { variantId } }),
      db.variant.deleteMany({ where: { id: { in: [variantId, foreignVariantId] } } }),
      db.product.deleteMany({ where: parent }),
      db.department.deleteMany({ where: { id: prefix } }),
      db.catalogMedia.deleteMany({ where: { id: { in: [...paths].map(src => src.slice(7)) } } }),
      db.user.deleteMany({ where: { id: { in: [ownerId, packerId] } } }),
    ]);
  });
  await db.user.create({ data: { id: ownerId, name: "Presentation owner", email: `${ownerId}@example.test`,
    staff: { create: { role: "OWNER" } } } });
  await db.user.create({ data: { id: packerId, name: "Presentation packer", email: `${packerId}@example.test`,
    staff: { create: { role: "PACKER" } } } });
  await db.department.create({ data: { id: prefix, slug: prefix, name: "Presentation fixture", shortName: "Fixture", description: "",
    position: 1, imageSrc: "/catalog/phone-stand.webp", imageAlt: "Fixture stand" } });
  const base = { departmentId: prefix, name: "Protective case", description: "Shared catalog description", shortDescription: "Default summary",
    specifications: [], keywords: [], addedOn: new Date(), position: 1 };
  await db.product.create({ data: { ...base, id: productId, slug: productId, foundation: true, publication: "ACTIVE",
    variants: { create: { id: variantId, sku: variantId.toUpperCase(), options: {}, label: "Standard", position: 0,
      optionSignature: "[]", isDefault: true,
      offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 15000 } } } },
  } });
  await db.product.create({ data: { ...base, id: legacyId, slug: legacyId, variants: { create: {
    id: foreignVariantId, sku: foreignVariantId.toUpperCase(), options: {}, label: "Legacy", position: 0,
  } } } });

  async function upload() {
    const color = randomBytes(3).toString("hex");
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: `#${color}` } }).png().toBuffer();
    const src = await storeCatalogImage(ownerId, bytes, "image/png");
    paths.add(src);
    assert.equal(await storeCatalogImage(ownerId, bytes, "image/png"), src);
    return src;
  }
  return { ownerId, packerId, productId, legacyId, variantId, foreignVariantId, base, upload };
}

test("shared and variant galleries reuse assets with ordered fallback and keep public media market scoped", async t => {
  const { ownerId, packerId, productId, legacyId, variantId, foreignVariantId, upload } = await fixture(t);
  const shared = { src: await upload(), alt: "Shared primary" };
  const variantPhoto = { src: await upload(), alt: "Variant primary" };
  const extra = { src: await upload(), alt: "Variant-only alternate" };
  const bundled = { src: "/catalog/phone-stand.webp", alt: "Shared alternate" };
  const input = { productId, revision: 0, images: [bundled, { ...shared, isPrimary: true }] };

  await assert.rejects(saveProductGallery(packerId, input), /permission/);
  await assert.rejects(saveProductGallery(ownerId, { ...input, productId: legacyId }), /catalog foundation/);
  await assert.rejects(saveProductGallery(ownerId, { ...input, variantId: foreignVariantId }), /variant of this product/);
  await assert.rejects(saveProductGallery(ownerId, { ...input, images: [shared, shared] }), /only once|each gallery image once/);
  await assert.rejects(saveProductGallery(ownerId, { ...input, images: [shared, bundled].map(image => ({ ...image, isPrimary: true })) }), /one primary/);
  await assert.rejects(saveProductGallery(ownerId, { ...input, images: [{ src: `/media/${randomBytes(32).toString("hex")}`, alt: "Missing" }] }), /does not exist/);
  await assert.rejects(saveProductGallery(ownerId, { ...input, images: [{ ...shared, alt: " " }] }), /images.0.alt/);
  const gallery = await saveProductGallery(ownerId, input);
  assert.equal(gallery.revision, 1);
  const sharedRows = await db.productImage.findMany({ where: { productId }, orderBy: { position: "asc" } });
  assert.deepEqual(sharedRows.map(row => [row.src, row.isPrimary]), [[shared.src, true], [bundled.src, false]]);
  await assert.rejects(saveProductGallery(ownerId, input), /product changed/i);

  const variantGallery = await saveProductGallery(ownerId, { productId, revision: 1, variantId,
    images: [extra, { ...variantPhoto, isPrimary: true }, { ...shared, alt: "Same asset on variant" }] });
  assert.equal(variantGallery.revision, 2);
  const variantRows = await db.variantImage.findMany({ where: { variantId }, orderBy: { position: "asc" } });
  assert.deepEqual(variantRows.map(row => [row.src, row.isPrimary]), [[variantPhoto.src, true], [extra.src, false], [shared.src, false]]);
  assert.deepEqual(selectCatalogImage(sharedRows, variantRows), variantPhoto);
  assert.deepEqual(selectCatalogImage(sharedRows, variantRows, image => image.src !== variantPhoto.src), extra);
  assert.deepEqual(selectCatalogImage(sharedRows, []), shared);
  assert.deepEqual(selectCatalogImage(sharedRows, [], image => image.src !== shared.src), bundled);
  assert.equal(selectCatalogImage(sharedRows, variantRows, () => false), undefined);
  assert.equal(await db.catalogMedia.count({ where: { id: shared.src.slice(7) } }), 1);

  const urls = [extra.src, shared.src, variantPhoto.src];
  assert.deepEqual([...(await availableMarketMedia(urls, "bd"))].sort(), urls.sort());
  assert.equal((await availableMarketMedia(urls, "us")).size, 0);
  assert.equal((await catalog.getProduct(productId, "bd"))?.variants[0]?.image?.src, `${variantPhoto.src}?market=bd`);
  const cleared = await saveProductGallery(ownerId, { productId, variantId, revision: 2, images: [] });
  assert.equal(cleared.revision, 3);
  assert.equal(await db.variantImage.count({ where: { variantId } }), 0);
  assert.equal((await db.variant.findUniqueOrThrow({ where: { id: variantId } })).imageSrc, null);
  assert.equal((await catalog.resolveVariants([variantId], "bd"))[0]?.image.src, `${shared.src}?market=bd`);

  await db.variant.update({ where: { id: variantId }, data: { active: false, isDefault: false, archivedAt: new Date() } });
  await assert.rejects(saveProductGallery(ownerId, { productId, variantId, revision: 3, images: [variantPhoto] }), /archived/);
});

test("product translations use canonical locale fallback and preserve the shared identity", async t => {
  const { ownerId, packerId, productId, legacyId, base } = await fixture(t);
  const generic = { name: "সুরক্ষামূলক কেস", description: "সাধারণ বিবরণ", shortDescription: "সারাংশ" };
  const regional = { name: "ফোন কেস", description: "বাংলাদেশের ভাষায় বিবরণ" };
  const input = { productId, revision: 0, locale: "bn", content: generic };
  await assert.rejects(saveProductTranslation(packerId, input), /permission/);
  await assert.rejects(saveProductTranslation(ownerId, { ...input, productId: legacyId }), /catalog foundation/);
  await assert.rejects(saveProductTranslation(ownerId, { ...input, locale: "bad_locale" }), /locale tag/);
  assert.equal((await saveProductTranslation(ownerId, input)).revision, 1);
  assert.equal((await saveProductTranslation(ownerId, { ...input, revision: 1, locale: "bn-bd", content: regional })).revision, 2);
  await assert.rejects(saveProductTranslation(ownerId, input), /product changed/i);

  const translations = await db.productTranslation.findMany({ where: { productId } });
  assert.deepEqual(selectProductContent(base, translations, "bn-BD"), { ...regional, locale: "bn-BD", shortDescription: generic.shortDescription });
  assert.deepEqual(selectProductContent(base, translations, "bn-IN"), { ...generic, locale: "bn" });
  assert.deepEqual(selectProductContent(base, translations, "en-US"), {
    name: base.name, description: base.description, shortDescription: base.shortDescription, locale: null,
  });
  const persisted = await db.product.findUniqueOrThrow({ where: { id: productId } });
  assert.equal(persisted.slug, productId);
  assert.equal(persisted.departmentId, base.departmentId);
  assert.equal(persisted.name, base.name);

  await saveProductTranslation(ownerId, { ...input, revision: 2, locale: "bn-bd", content: null });
  const retained = await db.productTranslation.findMany({ where: { productId } });
  assert.deepEqual(selectProductContent(base, retained, "bn-BD"), { ...generic, locale: "bn" });
});
