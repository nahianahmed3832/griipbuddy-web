import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { heroPhoto } from "../../src/lib/catalog/imagery.ts";
import { connectedCategoryDetail, connectedCollectionDetail } from "../../src/lib/catalog/connected-navigation.ts";
import { availableMarketEditorialMedia, availableMarketMedia, catalog, marketEditorialImage } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { storeCatalogImage } from "../../src/lib/staff/catalog-media.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("shared editorial cards use market-eligible catalog assets or neutral artwork", async () => {
  const id = `editorial-media-${randomBytes(8).toString("hex")}`;
  const gallery = { src: `/media/${randomBytes(32).toString("hex")}`, alt: "Fixture gallery" };
  const variantImage = { src: `/media/${randomBytes(32).toString("hex")}`, alt: "Fixture variant" };
  const image = { imageSrc: gallery.src, imageAlt: gallery.alt };
  const product = { departmentId: id, name: "Media fixture", description: "Fixture", specifications: {}, keywords: [],
    addedOn: new Date(), position: 1, publication: "ACTIVE" as const };
  try {
    await db.department.create({ data: { id, slug: id, name: "Fixture", shortName: "Fixture", description: "Fixture", position: 1, ...image } });
    await db.collection.create({ data: { id, slug: id, name: "Fixture", description: "Fixture", position: 1, ...image } });
    await db.product.create({ data: { ...product, id: `${id}-bd`, slug: `${id}-bd`, images: { create: { ...gallery, position: 0 } },
      variants: { create: { id: `v-${id}-bd`, sku: `${id}-bd`, label: "Fixture", position: 0, options: {},
        imageSrc: variantImage.src, imageAlt: variantImage.alt, offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 100 } } } },
    } });
    await db.product.create({ data: { ...product, id: `${id}-us`, slug: `${id}-us`,
      variants: { create: { id: `v-${id}-us`, sku: `${id}-us`, label: "Fixture", position: 0, options: {},
        offers: { create: { marketId: "us", currency: "USD", amountMinor: 100 } } } },
    } });
    const [bdDepartments, usDepartments, bdCollections, usCollections, bdAssets, usAssets] = await Promise.all([
      catalog.listDepartments("bd"), catalog.listDepartments("us"), catalog.listCollections("bd"), catalog.listCollections("us"),
      availableMarketMedia([gallery.src, variantImage.src], "bd"), availableMarketMedia([gallery.src, variantImage.src], "us"),
    ]);
    for (const rows of [bdDepartments, bdCollections]) assert.equal(rows.find(row => row.id === id)?.image?.src, `${gallery.src}?market=bd`);
    for (const rows of [usDepartments, usCollections]) assert.deepEqual(rows.find(row => row.id === id)?.image, heroPhoto);
    assert.equal(marketEditorialImage(variantImage, bdAssets, "bd")?.src, `${variantImage.src}?market=bd`);
    assert.equal(marketEditorialImage(variantImage, usAssets, "us"), undefined);
  } finally {
    const where = { id: { in: [`${id}-bd`, `${id}-us`] } };
    await db.$transaction([
      db.marketOffer.deleteMany({ where: { variant: { productId: where.id } } }),
      db.variant.deleteMany({ where: { productId: where.id } }), db.product.deleteMany({ where }),
      db.collection.deleteMany({ where: { id } }), db.department.deleteMany({ where: { id } }),
    ]);
  }
});

test("explicit editorial uploads become public only through their published category or market collection", async t => {
  const id = `catalog-editorial-${randomBytes(8).toString("hex")}`;
  const owner = `${id}-owner`;
  const paths: string[] = [];
  const bd = { marketId: "bd", locale: "en-BD" } as const;
  const us = { marketId: "us", locale: "en-US" } as const;
  await db.user.create({ data: { id: owner, name: "Editorial media fixture owner", email: `${owner}@example.test`,
    staff: { create: { role: "OWNER" } } } });
  t.after(async () => {
    await db.collection.deleteMany({ where: { id } });
    await db.departmentMarketPresentation.deleteMany({ where: { departmentId: id } });
    await db.department.deleteMany({ where: { id } });
    await db.catalogMedia.deleteMany({ where: { id: { in: paths.map(path => path.slice(7)) } } });
    await db.user.deleteMany({ where: { id: owner } });
  });
  async function asset(purpose: "product" | "editorial" = "editorial") {
    const pixels = randomBytes(48);
    const bytes = await sharp(pixels, { raw: { width: 4, height: 4, channels: 3 } }).png().toBuffer();
    const path = await storeCatalogImage(owner, bytes, "image/png", purpose);
    paths.push(path);
    return path;
  }
  const category = await asset();
  const marketImage = await asset();
  const collection = await asset();
  const productOnly = await asset("product");
  assert.equal((await availableMarketEditorialMedia(paths, "bd")).size, 0);

  await db.department.create({ data: { id, slug: id, name: "Editorial fixture", shortName: "Editorial", description: "Fixture",
    imageSrc: category, imageAlt: "Course collection photograph", bannerSrc: productOnly, bannerAlt: "Unapproved product image",
    kind: "DEPARTMENT", position: 0, state: "ACTIVE", marketPresentations: { create: {
      marketId: "bd", imageSrc: marketImage, imageAlt: "Bangladesh collection photograph", visibleInNavigation: false,
    } } } });
  await db.collection.create({ data: { id, slug: id, name: "Editorial fixture", description: "Fixture", position: 0,
    imageSrc: collection, imageAlt: "Editorial collection photograph", defaultPublished: false,
    marketPublications: { create: { marketId: "bd", published: true } } } });

  assert.deepEqual([...(await availableMarketEditorialMedia(paths, "bd"))].sort(), [marketImage, collection].sort());
  assert.deepEqual([...(await availableMarketEditorialMedia(paths, "us"))], [category]);
  const local = await connectedCategoryDetail(id, bd);
  assert.equal(local?.category.image.src, `${marketImage}?market=bd`);
  assert.equal(local?.category.visibleInNavigation, false);
  assert.equal(local?.category.banner, null);
  assert.equal((await connectedCategoryDetail(id, us))?.category.image.src, `${category}?market=us`);
  assert.equal((await connectedCollectionDetail(id, bd))?.collection.image?.src, `${collection}?market=bd`);
  assert.equal(await connectedCollectionDetail(id, us), null);

  await db.department.update({ where: { id }, data: { state: "ARCHIVED" } });
  await db.collectionMarketPublication.update({ where: { collectionId_marketId: { collectionId: id, marketId: "bd" } }, data: { published: false } });
  assert.equal((await availableMarketEditorialMedia(paths, "bd")).size, 0);
  assert.equal((await availableMarketEditorialMedia(paths, "us")).size, 0);
});
