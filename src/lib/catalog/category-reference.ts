import { getDb, type DbReader } from "../db/client.ts";

export const recoveredCategorySource = "recovered-mongo";
export const recoveredCategoryId = /^[a-f0-9]{24}$/;
export const categoryCodeNamespace = /^[a-z][a-z0-9-]{0,39}$/;
export const categoryBusinessCode = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const categoryCodePrefix = "category-code:";

export function categoryCodeEntity(namespace: string) {
  return `${categoryCodePrefix}${namespace}`;
}

async function resolveReviewedCategory(entity: string, sourceId: string, db: DbReader) {
  const mapping = await db.catalogMigrationMapping.findUnique({
    where: { sourceSystem_entity_sourceId: { sourceSystem: recoveredCategorySource, entity, sourceId } },
    select: { targetId: true },
  });
  return mapping?.targetId ?? null;
}

export function resolveRecoveredCategoryId(sourceId: string, db: DbReader = getDb()) {
  return recoveredCategoryId.test(sourceId) ? resolveReviewedCategory("category", sourceId, db) : null;
}

export function resolveCategoryBusinessCode(namespace: string, code: string, db: DbReader = getDb()) {
  return categoryCodeNamespace.test(namespace) && categoryBusinessCode.test(code)
    ? resolveReviewedCategory(categoryCodeEntity(namespace), code, db) : null;
}

export async function readCategoryBusinessCodes(categoryId: string, db: DbReader = getDb()) {
  const rows = await db.catalogMigrationMapping.findMany({ where: {
    sourceSystem: recoveredCategorySource, entity: { startsWith: categoryCodePrefix }, targetId: categoryId,
  }, orderBy: [{ entity: "asc" }, { sourceId: "asc" }], select: { entity: true, sourceId: true } });
  return rows.map(({ entity, sourceId }) => ({ namespace: entity.slice(categoryCodePrefix.length), value: sourceId }));
}
