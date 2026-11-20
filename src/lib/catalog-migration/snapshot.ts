import type { DbReader } from "../db/client.ts";
import { migrationDigest, type MigrationMapping } from "./contracts.ts";
import type { CategoryManifest } from "./catalog.ts";
import type { LegacyCategory } from "./category-reconciliation.ts";
import type { ProductMigrationBatch, ReviewBatch } from "./manifest.ts";

export function mappingKey(mapping: Pick<MigrationMapping, "sourceSystem" | "entity" | "sourceId">) {
  const { sourceSystem, entity, sourceId } = mapping;
  return { sourceSystem, entity, sourceId };
}

export async function readMappings(db: DbReader, mappings: readonly MigrationMapping[]) {
  if (!mappings.length) return [];
  return db.catalogMigrationMapping.findMany({
    where: { OR: mappings.map(mappingKey) },
    orderBy: [{ sourceSystem: "asc" }, { entity: "asc" }, { sourceId: "asc" }],
    select: { sourceSystem: true, entity: true, sourceId: true, targetId: true },
  });
}

export async function categoryTargetDigest(db: DbReader, categories: readonly CategoryManifest[], mappings: MigrationMapping[],
  legacy?: readonly LegacyCategory[]) {
  const rows = await db.department.findMany({
    where: { id: { in: categories.map(row => row.id) } }, orderBy: { id: "asc" },
  });
  const references = await readMappings(db, mappings);
  if (!legacy?.length) return migrationDigest([rows, references]);
  const reconciled = await db.department.findMany({
    where: { id: { in: legacy.map(row => row.targetId) } }, orderBy: { id: "asc" }, include: {
      translations: { orderBy: { locale: "asc" } }, slugAliases: { orderBy: [{ locale: "asc" }, { slug: "asc" }] },
      products: { select: { id: true }, orderBy: { id: "asc" } },
      secondaryProducts: { select: { productId: true }, orderBy: { productId: "asc" } },
      marketPresentations: { orderBy: { marketId: "asc" } }, attributeTemplates: { orderBy: { attributeId: "asc" } },
      menuItems: { orderBy: [{ menuId: "asc" }, { position: "asc" }] },
    },
  });
  return migrationDigest([rows, references, reconciled]);
}

export async function productTargetDigest(
  db: DbReader, batch: ProductMigrationBatch, review: ReviewBatch, mappings: MigrationMapping[],
) {
  const ids = [...new Set([batch.catalog.targetProductId, ...batch.catalog.sourceProductIds])];
  const products = await db.product.findMany({
    where: { id: { in: ids } }, orderBy: { id: "asc" },
    include: {
      images: { orderBy: { position: "asc" } },
      collections: { orderBy: { collectionId: "asc" } },
      secondaryCategories: { orderBy: { departmentId: "asc" } },
      optionDefinitions: { orderBy: { id: "asc" }, include: { values: { orderBy: { id: "asc" } } } },
    },
  });
  const variants = await db.variant.findMany({
    where: { id: { in: review.targetVariantIds } }, orderBy: { id: "asc" },
    include: {
      optionSelections: { orderBy: { optionId: "asc" } },
      images: { orderBy: { position: "asc" } },
      compatibility: { orderBy: { modelId: "asc" } },
      offers: { orderBy: { marketId: "asc" }, include: { identity: true } },
      inventory: true, locationInventory: { orderBy: { locationId: "asc" } },
      inventoryPools: {
        orderBy: { id: "asc" },
        include: { movements: { orderBy: { id: "asc" } }, allocations: { orderBy: { id: "asc" } } },
      },
    },
  });
  const redirects = await db.catalogMigrationRedirect.findMany({
    where: { sourceProductId: { in: ids } }, orderBy: { slug: "asc" },
  });
  const routes = batch.commerce.inventory.flatMap(pool => pool.routes.map(({ marketId }) => ({ locationId: pool.locationId, marketId })));
  const service = routes.length ? await db.dispatchLocationMarket.findMany({
    where: { OR: routes }, orderBy: [{ locationId: "asc" }, { marketId: "asc" }],
  }) : [];
  return migrationDigest([products, variants, redirects, service, await readMappings(db, mappings)]);
}
