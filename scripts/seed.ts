import "./load-env.ts";
import { collections, departments, offers, products } from "../prisma/demo-data.ts";
import { variantLabel } from "../src/lib/catalog/types.ts";
import { getDb } from "../src/lib/db/client.ts";
import { requireLocalDatabase, stagingDatabase } from "../src/lib/db/local.ts";
import { hybridDemoMode } from "../src/lib/release-config.ts";

if (!((stagingDatabase() || hybridDemoMode()) && process.env.ALLOW_DEMO_SEED === "1")) requireLocalDatabase();
const db = getDb();

try {
  await db.$transaction(async (tx) => {
    for (const [position, { image, ...department }] of departments.entries()) {
      await tx.department.upsert({
        where: { id: department.id }, update: {},
        create: { ...department, position, imageSrc: image.src, imageAlt: image.alt },
      });
    }

    const seededStock = new Map<string, number>();
    for (const offer of offers) {
      seededStock.set(offer.variantId, Math.max(seededStock.get(offer.variantId) ?? 0, offer.stock));
    }
    // Keep one fixture out of stock in both markets.
    seededStock.set("v-mug-lilac", 0);

    for (const [position, product] of products.entries()) {
      await tx.product.upsert({
        where: { id: product.id }, update: {},
        create: {
          id: product.id, slug: product.slug, name: product.name, departmentId: product.departmentId,
          description: product.description, specifications: [...product.specifications], keywords: [...product.keywords],
          addedOn: new Date(product.addedOn), newArrival: product.newArrival, featured: product.featured, position,
          publication: "ACTIVE", demo: true,
          images: { create: product.images.map((image, index) => ({ ...image, position: index })) },
        },
      });
      for (const [variantPosition, variant] of product.variants.entries()) {
        await tx.variant.upsert({
          where: { id: variant.id }, update: {},
          create: {
            id: variant.id, sku: `GB-${variant.id.slice(2).toUpperCase()}`, productId: product.id,
            options: { ...variant.options }, label: variantLabel(variant), position: variantPosition,
            imageSrc: variant.image?.src, imageAlt: variant.image?.alt,
            inventory: { create: { available: seededStock.get(variant.id) ?? 0 } },
          },
        });
      }
    }

    for (const { variantId, marketId, currency, amountMinor } of offers) {
      await tx.marketOffer.upsert({
        where: { variantId_marketId: { variantId, marketId } }, update: {},
        create: { variantId, marketId, currency, amountMinor },
      });
    }

    for (const [position, collection] of collections.entries()) {
      await tx.collection.upsert({
        where: { id: collection.id }, update: {},
        create: {
          id: collection.id, slug: collection.slug, name: collection.name, description: collection.description,
          position, imageSrc: collection.image?.src, imageAlt: collection.image?.alt,
          selection: collection.selection === "new" ? "NEW" : collection.selection === "featured" ? "FEATURED" : "CURATED",
        },
      });
      for (const productId of collection.productIds ?? []) {
        await tx.collectionProduct.upsert({
          where: { collectionId_productId: { collectionId: collection.id, productId } }, update: {},
          create: { collectionId: collection.id, productId },
        });
      }
    }

    await tx.checkoutPolicy.upsert({
      where: { marketId: "bd" }, update: {},
      create: {
        marketId: "bd", countryCode: "BD", currency: "BDT", enabled: true, codEnabled: true,
        taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 500, taxLabel: "Demo tax (5%)",
      },
    });
    await tx.checkoutPolicy.upsert({
      where: { marketId: "us" }, update: {},
      create: { marketId: "us", countryCode: "US", currency: "USD" },
    });
    for (const [district, districtLabel, chargeMinor] of [["dhaka", "Dhaka", 8000], ["chattogram", "Chattogram", 13000]] as const) {
      await tx.deliveryZone.upsert({
        where: { marketId_district_method: { marketId: "bd", district, method: "standard" } }, update: {},
        create: { marketId: "bd", district, districtLabel, method: "standard", label: "Standard delivery", chargeMinor },
      });
    }
  }, { timeout: 30_000 });
  console.log("Seeded demo catalog and Bangladesh delivery fixtures. Existing stock, prices, staff and orders were preserved.");
} finally {
  await db.$disconnect();
}
