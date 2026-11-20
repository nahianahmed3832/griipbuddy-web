import type { Prisma } from "../../generated/prisma/client.ts";
import { migrationVersion, nativeSourceSystem } from "../catalog-migration/contracts.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { OperationError } from "../staff/operation-error.ts";
import { recoveredCategorySource } from "./category-reference.ts";
import { scopedCatalogPilotDigest, scopedCatalogPilotRequested } from "./main-admin-config.ts";

export async function scopedCatalogPilotTargets(db: DbReader = getDb()) {
  const digest = scopedCatalogPilotDigest();
  if (!digest) return null;
  const run = await db.catalogMigrationRun.findUnique({
    where: { id: digest },
    select: {
      version: true, status: true, failureCode: true, expectedBatches: true,
      _count: { select: { checkpoints: true } },
      mappings: {
        where: { OR: [
          { sourceSystem: recoveredCategorySource, entity: { in: ["category", "product", "variant"] } },
          { sourceSystem: nativeSourceSystem, entity: "category" },
        ] },
        select: { sourceSystem: true, entity: true, sourceId: true, targetId: true },
      },
    },
  });
  if (!run || run.version !== migrationVersion || run.status !== "COMPLETED" || run.failureCode ||
      run.expectedBatches < 1 || run._count.checkpoints !== run.expectedBatches) return null;
  const recovered = (entity: string) => [...new Set(run.mappings
    .filter(row => row.sourceSystem === recoveredCategorySource && row.entity === entity).map(row => row.targetId))];
  const recoveredCategories = new Set(recovered("category"));
  const nativeLeaves = run.mappings.filter(row => row.sourceSystem === nativeSourceSystem && row.sourceId === row.targetId)
    .map(row => row.targetId);
  const productIds = recovered("product"), variantIds = recovered("variant");
  if (!recoveredCategories.size || !productIds.length || !variantIds.length) return null;
  const nodes = await db.department.findMany({
    where: { id: { in: [...recoveredCategories, ...nativeLeaves] } }, select: { id: true, parentId: true, kind: true },
  });
  // A reviewed native leaf may provide a valid placement where the recovered branch stops at Category.
  const roots = new Set(nodes.filter(node => recoveredCategories.has(node.id) && node.kind === "DEPARTMENT" && !node.parentId).map(node => node.id));
  const branches = new Set(nodes.filter(node => recoveredCategories.has(node.id) && node.kind === "CATEGORY" &&
    node.parentId && roots.has(node.parentId)).map(node => node.id));
  const leaves = nodes.filter(node => node.kind === "SUBCATEGORY" && node.parentId && branches.has(node.parentId)).map(node => node.id);
  const categoryIds = [...roots, ...branches, ...leaves];
  if (!leaves.length || [...recoveredCategories].some(id => !categoryIds.includes(id))) return null;
  const [productCount, rows] = await Promise.all([
    db.product.count({ where: { id: { in: productIds }, departmentId: { in: leaves }, foundation: true } }),
    db.variant.findMany({ where: { productId: { in: productIds } }, select: { id: true } }),
  ]);
  return productCount === productIds.length && rows.length === variantIds.length && rows.every(row => variantIds.includes(row.id))
    ? { categoryIds, productIds, variantIds } : null;
}

export async function scopedCatalogPilotReady(db?: DbReader) {
  return Boolean(await scopedCatalogPilotTargets(db));
}

const connectedVariant: Prisma.VariantWhereInput = {
  OR: [{ optionSignature: { not: null } }, { managedInventory: true }, { inventoryPools: { some: {} } }, { offerIdentities: { some: {} } },
    { offers: { some: { offerId: { not: null } } } }],
};

async function mappedCatalogIds(db: DbReader, entity: "product" | "variant" | "category") {
  const mappings = await db.catalogMigrationMapping.findMany({
    where: { entity, sourceSystem: { in: [nativeSourceSystem, recoveredCategorySource] } },
    select: { sourceSystem: true, sourceId: true, targetId: true },
  });
  return [...new Set(mappings.flatMap(row => row.sourceSystem === nativeSourceSystem ?
    [row.targetId, row.sourceId] : [row.targetId]))];
}

export async function legacyProductScope(db: DbReader): Promise<Prisma.ProductWhereInput> {
  const [products, variants] = await Promise.all([mappedCatalogIds(db, "product"), mappedCatalogIds(db, "variant")]);
  return {
    id: { notIn: products }, foundation: false, migratedFromSlug: null,
    variants: { none: { OR: [connectedVariant, { id: { in: variants } }] } },
  };
}

export async function legacyCategoryScope(db: DbReader): Promise<Prisma.DepartmentWhereInput> {
  return { kind: null, id: { notIn: await mappedCatalogIds(db, "category") } };
}

export async function requireScopedLegacyWriter(db: DbReader) {
  if (!scopedCatalogPilotRequested()) return false;
  if (!await scopedCatalogPilotReady(db)) throw new OperationError("The reviewed catalog pilot is unavailable.");
  return true;
}

export async function requireLegacyPilotProduct(db: DbReader, productId: string, exists: boolean) {
  const allowed = exists ?
    await db.product.findFirst({ where: { AND: [{ id: productId }, await legacyProductScope(db)] }, select: { id: true } }) :
    !(await mappedCatalogIds(db, "product")).includes(productId);
  if (!allowed) {
    throw new OperationError("Use the main GriipBuddy admin for this catalog product.");
  }
}

export async function requireLegacyPilotVariant(db: DbReader, variantId: string) {
  if (!await requireScopedLegacyWriter(db)) return;
  if (!await db.variant.findFirst({
    where: { id: variantId, product: await legacyProductScope(db) }, select: { id: true },
  })) throw new OperationError("Use the main GriipBuddy admin for this catalog variant.");
}

export async function requireLegacyPilotCategories(db: DbReader, ids: Array<string | null | undefined>) {
  const categories = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const count = await db.department.count({ where: { AND: [{ id: { in: categories } }, await legacyCategoryScope(db)] } });
  if (count !== categories.length) throw new OperationError("Use the main GriipBuddy admin for this catalog category.");
}
