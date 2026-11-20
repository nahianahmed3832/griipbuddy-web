import { nativeSourceSystem } from "../catalog-migration/contracts.ts";
import type { DbReader } from "../db/client.ts";
import { validVariantId } from "./model.ts";

// Older recovered cart entries used the v- storefront prefix for the Mongo ID.
const recoveredVariant = /^v-[a-f0-9]{24}$/;

export async function resolveCartVariantReferences(variantIds: readonly string[], db: DbReader) {
  const ids = [...new Set(variantIds)].filter(validVariantId);
  if (!ids.length) return new Map<string, string>();
  const recovered = ids.filter(id => recoveredVariant.test(id));
  const mappings = await db.catalogMigrationMapping.findMany({
    where: { entity: "variant", run: { status: "COMPLETED" }, OR: [
      { sourceSystem: nativeSourceSystem, sourceId: { in: ids } },
      { sourceSystem: "recovered-mongo", sourceId: { in: recovered.map(id => id.slice(2)) } },
    ] },
    select: { sourceSystem: true, sourceId: true, targetId: true },
  });
  const targets = new Map<string, Set<string>>();
  for (const { sourceSystem, sourceId, targetId } of mappings) {
    const id = sourceSystem === nativeSourceSystem ? sourceId : `v-${sourceId}`;
    const values = targets.get(id) ?? new Set<string>();
    values.add(targetId);
    targets.set(id, values);
  }
  return new Map(ids.flatMap(id => {
    const values = targets.get(id);
    if (!values) return [[id, id] as const];
    const [target] = values;
    return values.size === 1 && validVariantId(target) ? [[id, target] as const] : [];
  }));
}
