import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client.ts";
import { migrationVersion } from "../../src/lib/catalog-migration/contracts.ts";
import { migrationManifestInput } from "../../src/lib/catalog-migration/manifest.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { deviceLookupKey } from "../../src/lib/catalog/device-fitment.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";

export async function createCatalogMigrationFixture(db: PrismaClient) {
  requireLocalDatabase("griipbuddy_test");
  const key = `stage5-${randomUUID().slice(0, 8)}`;
  const categories = {
    departmentId: `${key}-devices`, casesCategoryId: `${key}-cases`, accessoriesCategoryId: `${key}-accessories`,
    casesLeafId: `${key}-protective`, travelLeafId: `${key}-travel`,
  };
  const { departmentId, casesCategoryId, accessoriesCategoryId, casesLeafId, travelLeafId } = categories;
  const categoryRows = [
    { id: departmentId, parentId: null, kind: "DEPARTMENT", name: "Devices" },
    { id: casesCategoryId, parentId: departmentId, kind: "CATEGORY", name: "Cases" },
    { id: accessoriesCategoryId, parentId: departmentId, kind: "CATEGORY", name: "Accessories" },
    { id: casesLeafId, parentId: casesCategoryId, kind: "SUBCATEGORY", name: "Protective cases" },
    { id: travelLeafId, parentId: accessoriesCategoryId, kind: "SUBCATEGORY", name: "Travel accessories" },
  ] as const;
  const productIds = {
    case: `${key}-case`, caseSource: `${key}-phone-b-case`, accessory: `${key}-stand`,
  };
  const caseProductId = productIds.case;
  const caseSourceProductId = productIds.caseSource;
  const accessoryProductId = productIds.accessory;
  const caseSlug = `${key}-protective-case-black`;
  const caseSourceSlug = `${key}-protective-case-blue`;
  const accessorySlug = `${key}-universal-stand`;
  const variantIds = Object.values(productIds).map(id => `v-${id}`);
  const [caseVariantId, caseSourceVariantId, accessoryVariantId] = variantIds;
  const [caseSku, caseSourceSku, accessorySku] = Object.values(productIds).map(id => id.toUpperCase());
  const locationId = `${key}-shared-warehouse`;
  const modelA = `${key}-phone-a`;
  const modelB = `${key}-phone-b`;
  const deviceBrand = `${key} Fixture Devices`;
  const models = [
    { id: modelA, name: "Phone A" }, { id: modelB, name: "Phone B" },
  ].map(({ id, name }) => ({ id, name, brand: deviceBrand, lookupKey: deviceLookupKey(`${deviceBrand} ${name}`) }));
  const modelIds = models.map(({ id }) => id);
  const aliases = [
    { modelId: modelA, label: `${key} Fixture A` }, { modelId: modelB, label: `${key} Fixture B` },
  ].map(row => ({ ...row, lookupKey: deviceLookupKey(row.label) }));
  const prices = {
    case: { bd: 159_900, us: 2_499 }, caseSource: { bd: 169_900, us: 2_799 }, accessory: { bd: 59_900, us: 1_299 },
  };
  const stock = { case: 9, caseSource: 12, accessory: 7 };
  const routes = [{ marketId: "bd" }, { marketId: "us" }] as const;
  const offers = (variantId: string, price: { bd: number; us: number }) => [
    { variantId, marketId: "bd", currency: "BDT", amountMinor: price.bd },
    { variantId, marketId: "us", currency: "USD", amountMinor: price.us },
  ] as const;
  const offerRows = [...offers(caseVariantId, prices.case), ...offers(caseSourceVariantId, prices.caseSource),
    ...offers(accessoryVariantId, prices.accessory)];
  const warehouseBalance = { kind: "location", locationId } as const;
  const sharedBalance = { kind: "shared" } as const;
  const balance = (variantId: string, onHand: number, legacySources: (typeof warehouseBalance | typeof sharedBalance)[]) => ({
    variantId, ownerId: storeShop.id, locationId, onHand, reserved: 0, allocated: 0,
    evidence: `${key}-physical-stock-count`, legacySources, routes: [...routes],
  });
  const recoveredCaseProductId = `${key}-mongo-blue-case`;
  const recoveredCaseVariantId = `${key}-mongo-blue-case-sku`;
  const manifest = migrationManifestInput.parse({
    version: migrationVersion, sourceKind: "representative-fixtures",
    categories: categoryRows.map(({ id, parentId, kind }) => ({ id, parentId, kind })),
    batches: [
      {
        catalog: {
          targetProductId: caseProductId, sourceProductIds: [caseProductId, caseSourceProductId],
          primaryCategoryId: casesLeafId, secondaryCategoryIds: [travelLeafId], defaultVariantId: caseVariantId,
          groupingEvidence: { kind: "supplier-parent", reference: `${key}-supplier-family` },
        },
        commerce: {
          offers: offerRows.filter(row => row.variantId !== accessoryVariantId).map(row => ({ ...row, sellerId: storeShop.id })),
          inventory: [balance(caseVariantId, stock.case, [sharedBalance, warehouseBalance]),
            balance(caseSourceVariantId, stock.caseSource, [warehouseBalance])],
        },
        legacyReferences: [
          { sourceSystem: "recovered-mongo", entity: "product", sourceId: recoveredCaseProductId, targetId: caseProductId,
            evidence: `${key}-recovered-listing-export` },
          { sourceSystem: "recovered-mongo", entity: "variant", sourceId: recoveredCaseVariantId, targetId: caseSourceVariantId,
            evidence: `${key}-recovered-sku-export` },
        ],
      },
      {
        catalog: {
          targetProductId: accessoryProductId, sourceProductIds: [accessoryProductId], primaryCategoryId: travelLeafId,
          compatibility: [{ variantId: accessoryVariantId, modelIds,
            evidence: { kind: "manufacturer-variants", reference: `${key}-stand-fitment` } }],
        },
        commerce: {
          offers: offerRows.filter(row => row.variantId === accessoryVariantId).map(row => ({ ...row, sellerId: storeShop.id })),
          inventory: [balance(accessoryVariantId, stock.accessory, [sharedBalance])],
        },
      },
    ],
  });

  await db.$transaction(async tx => {
    await tx.department.createMany({ data: categoryRows.map(({ id, name }, position) => ({
      id, slug: id, name, shortName: name, description: "Legacy catalog category fixture.",
      imageSrc: "/catalog/phone-stand.webp", imageAlt: "Example catalog category", position,
    })) });
    await tx.deviceModel.createMany({ data: models });
    await tx.deviceModelAlias.createMany({ data: aliases });
    await tx.dispatchLocation.create({ data: { id: locationId, name: "Shared warehouse fixture", marketId: "bd" } });
    await tx.product.createMany({ data: [
      { id: caseProductId, slug: caseSlug, name: "Protective case for Phone A", departmentId: casesLeafId },
      { id: caseSourceProductId, slug: caseSourceSlug, name: "Protective case for Phone B", departmentId: travelLeafId },
      { id: accessoryProductId, slug: accessorySlug, name: "Universal stand", departmentId: travelLeafId },
    ].map((row, position) => ({
      ...row, position, brand: "Fixture Devices", description: `${row.name} from the legacy catalog.`,
      specifications: [{ label: "Care", value: "Wipe clean" }], keywords: [row.name],
      addedOn: new Date("2026-01-01T00:00:00.000Z"), publication: "ACTIVE",
    })) });
    await tx.productImage.createMany({ data: [
      { productId: caseProductId, src: "/catalog/headphones-black.webp", alt: "Black case reference image" },
      { productId: caseSourceProductId, src: "/catalog/headphones-taupe.webp", alt: "Blue case reference image" },
      { productId: accessoryProductId, src: "/catalog/phone-stand.webp", alt: "Stand reference image" },
    ].map(row => ({ ...row, position: 0, isPrimary: true })) });
    await tx.variant.create({ data: { id: caseVariantId, productId: caseProductId, sku: caseSku,
      options: { Model: "Phone A", Design: "Plain", Color: "Black" }, label: "Phone A / Plain / Black", position: 0 } });
    await tx.variant.create({ data: { id: caseSourceVariantId, productId: caseSourceProductId, sku: caseSourceSku,
      options: { Model: "Phone B", Design: "Floral", Color: "Blue" }, label: "Phone B / Floral / Blue", position: 0,
      imageSrc: "/catalog/headphones-taupe.webp", imageAlt: "Blue fixture version" } });
    await tx.variant.create({ data: { id: accessoryVariantId, productId: accessoryProductId, sku: accessorySku,
      options: {}, label: "Universal stand", position: 0 } });
    await tx.marketOffer.createMany({ data: offerRows.map(row => row.variantId === caseSourceVariantId && row.marketId === "us"
      ? { ...row, discountMinor: 200, discountStartsAt: new Date("2026-01-01T00:00:00.000Z"),
        discountEndsAt: new Date("2027-01-01T00:00:00.000Z"), revision: 3 }
      : row) });
    await tx.inventory.createMany({ data: [
      { variantId: caseVariantId, available: stock.case }, { variantId: accessoryVariantId, available: stock.accessory },
    ] });
    await tx.locationInventory.createMany({ data: [
      { variantId: caseVariantId, locationId, available: stock.case },
      { variantId: caseSourceVariantId, locationId, available: stock.caseSource },
    ] });
  });

  async function cleanup(runIds: readonly string[] = []) {
    await db.$transaction(async tx => {
      await tx.catalogMigrationMapping.deleteMany({ where: { runId: { in: [...runIds] } } });
      await tx.catalogMigrationCheckpoint.deleteMany({ where: { runId: { in: [...runIds] } } });
      await tx.catalogMigrationRun.deleteMany({ where: { id: { in: [...runIds] } } });
      await tx.catalogMigrationRedirect.deleteMany({ where: { sourceProductId: caseSourceProductId } });
      const variant = { in: variantIds };
      const pool = { variantId: variant, locationId };
      await tx.inventoryMovement.deleteMany({ where: { OR: [{ pool }, { relatedPool: pool }] } });
      await tx.inventoryPool.deleteMany({ where: pool });
      await tx.dispatchLocationMarket.deleteMany({ where: { locationId } });
      await tx.marketOffer.deleteMany({ where: { variantId: variant } });
      await tx.marketOfferIdentity.deleteMany({ where: { variantId: variant } });
      await tx.inventory.deleteMany({ where: { variantId: variant } });
      await tx.locationInventory.deleteMany({ where: { variantId: variant, locationId } });
      await tx.dispatchLocation.deleteMany({ where: { id: locationId } });
      await tx.variantOptionSelection.deleteMany({ where: { variantId: variant } });
      await tx.variant.deleteMany({ where: { id: variant } });
      await tx.product.deleteMany({ where: { id: { in: Object.values(productIds) } } });
      for (const { id } of [...categoryRows].reverse()) await tx.department.deleteMany({ where: { id } });
      await tx.deviceModelAlias.deleteMany({ where: { modelId: { in: modelIds } } });
      await tx.deviceModel.deleteMany({ where: { id: { in: modelIds } } });
    });
  }

  return {
    manifest, key, caseProductId, caseSourceProductId, caseSlug, caseSourceSlug, caseVariantId, caseSourceVariantId,
    caseSku, caseSourceSku, accessoryProductId, accessoryVariantId, accessorySku, accessorySlug, locationId, categories,
    modelIds, modelAliasKeys: aliases.map(({ lookupKey }) => lookupKey), prices, stock, recoveredCaseProductId, recoveredCaseVariantId, cleanup,
  };
}
