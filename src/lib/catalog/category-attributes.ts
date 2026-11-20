import { Prisma, type CatalogAttributeDefinition } from "../../generated/prisma/client.ts";
import { getDb, type DbReader } from "../db/client.ts";

export type EffectiveCategoryAttribute = CatalogAttributeDefinition & {
  sourceDepartmentId: string;
  required: boolean;
  filterable: boolean;
  position: number;
  inheritable: boolean;
};

export async function categoryAttributes(departmentId: string, db: DbReader = getDb()) {
  return (await categoryAttributesForMany([departmentId], db)).get(departmentId) ?? [];
}

export async function categoryAttributesForMany(departmentIds: readonly string[], db: DbReader = getDb()) {
  const byDepartment = new Map<string, EffectiveCategoryAttribute[]>();
  if (!departmentIds.length) return byDepartment;
  // Skip local-only ancestor rules before picking the closest rule. An exclusion still masks the inherited rule.
  const rows = await db.$queryRaw<(EffectiveCategoryAttribute & { rootId: string })[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id AS "rootId", id, "parentId", ARRAY[id] AS path, 0 AS depth
      FROM "Department" WHERE id IN (${Prisma.join([...new Set(departmentIds)])})
      UNION ALL
      SELECT child."rootId", parent.id, parent."parentId", child.path || parent.id, child.depth + 1
      FROM ancestors child JOIN "Department" parent ON parent.id = child."parentId"
      WHERE NOT parent.id = ANY(child.path)
    ), nearest AS (
      SELECT DISTINCT ON (ancestors."rootId", template."attributeId") ancestors."rootId", template.*
      FROM ancestors
      JOIN "CategoryAttributeTemplate" template ON template."departmentId" = ancestors.id
      WHERE ancestors.depth = 0 OR template.inheritable
      ORDER BY ancestors."rootId", template."attributeId", ancestors.depth
    )
    SELECT nearest."rootId", definition.id, definition.name, definition.scope, definition."dataType",
           definition."allowedValues", definition."variantOptionKey", nearest.required,
           nearest.filterable, nearest.position, nearest.inheritable,
           nearest."departmentId" AS "sourceDepartmentId"
    FROM nearest JOIN "CatalogAttributeDefinition" definition ON definition.id = nearest."attributeId"
    WHERE NOT nearest.excluded
    ORDER BY nearest."rootId", nearest.position, definition.id COLLATE "C"
  `;
  for (const { rootId, ...template } of rows) {
    const templates = byDepartment.get(rootId) ?? [];
    templates.push(template);
    byDepartment.set(rootId, templates);
  }
  return byDepartment;
}

export async function productCategoryAttributes(productId: string, db: DbReader = getDb()) {
  const product = await db.product.findUnique({ where: { id: productId }, select: { departmentId: true } });
  return product ? categoryAttributes(product.departmentId, db) : null;
}

type Values = Readonly<Record<string, unknown>>;
type VariantValues = { id: string; active?: boolean; values?: Values; options?: unknown };
type ValueIssue = {
  attributeId: string;
  variantId?: string;
  reason: "required" | "invalid_value" | "not_applicable" | "use_variant_option";
};

function optionValue(options: unknown, key: string) {
  return options && typeof options === "object" && !Array.isArray(options) && Object.hasOwn(options, key)
    ? (options as Values)[key]
    : undefined;
}

function validValue(attribute: EffectiveCategoryAttribute, value: unknown): boolean {
  if (attribute.dataType === "NUMBER") return typeof value === "number" && Number.isFinite(value);
  if (attribute.dataType === "BOOLEAN") return typeof value === "boolean";
  if (attribute.dataType === "ENUM") return typeof value === "string" && attribute.allowedValues.includes(value);
  const max = attribute.variantOptionKey ? 70 : 240;
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function scopeIssues(
  templates: ReadonlyMap<string, EffectiveCategoryAttribute>, values: Values, variant?: VariantValues,
): ValueIssue[] {
  const issues: ValueIssue[] = [];
  const record = (attributeId: string, reason: ValueIssue["reason"]) => {
    issues.push({ attributeId, ...(variant && { variantId: variant.id }), reason });
  };
  for (const id of Object.keys(values)) {
    const attribute = templates.get(id);
    if (!attribute) record(id, "not_applicable");
    else if (attribute.variantOptionKey) record(id, "use_variant_option");
  }
  for (const attribute of templates.values()) {
    const value = attribute.variantOptionKey
      ? optionValue(variant?.options, attribute.variantOptionKey)
      : Object.hasOwn(values, attribute.id) ? values[attribute.id] : undefined;
    if (value === undefined) {
      if (attribute.required) record(attribute.id, "required");
    } else if (!validValue(attribute, value)) {
      record(attribute.id, "invalid_value");
    }
  }
  return issues;
}

export function validateCategoryAttributeValues(
  templates: readonly EffectiveCategoryAttribute[],
  input: { productValues?: Values; variants?: readonly VariantValues[] },
): ValueIssue[] {
  const product = new Map<string, EffectiveCategoryAttribute>();
  const variant = new Map<string, EffectiveCategoryAttribute>();
  for (const template of templates) {
    (template.scope === "PRODUCT" ? product : variant).set(template.id, template);
  }
  return [
    ...scopeIssues(product, input.productValues ?? {}),
    ...(input.variants ?? []).flatMap(row => row.active === false ? [] : scopeIssues(variant, row.values ?? {}, row)),
  ];
}
