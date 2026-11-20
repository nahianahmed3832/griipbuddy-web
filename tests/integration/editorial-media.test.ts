import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { heroPhoto } from "../../src/lib/catalog/imagery.ts";
import { availableMarketMedia, catalog, marketEditorialImage } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";

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
