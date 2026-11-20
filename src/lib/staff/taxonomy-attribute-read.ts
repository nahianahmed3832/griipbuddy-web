import { z } from "zod";
import type { CatalogAttributeDefinition, CategoryAttributeTemplate } from "../../generated/prisma/client.ts";
import { categoryAttributes, validateCategoryAttributeValues, type EffectiveCategoryAttribute } from "../catalog/category-attributes.ts";
import { departmentAncestorPath, departmentFamily } from "../catalog/departments.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { productIdField } from "./catalog-input.ts";
import { assignedAttributeSelection, assignedAttributeValues } from "./category-attribute-values.ts";
import { categoryAttributeTemplateInput } from "./category-attributes.ts";
import { authorize } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";

const workspaceInput = z.strictObject({ categoryId: productIdField });
const categoryData = { id: true, parentId: true, state: true, kind: true, revision: true } as const;

export async function categoryAttributeWorkspace(actorId: string, raw: unknown, db: DbReader = getDb()) {
  await authorize(db, actorId, true);
  const { categoryId } = catalogWriteInput(workspaceInput, raw);
  const [category, definitions, local, effective] = await Promise.all([
    db.department.findUnique({ where: { id: categoryId }, select: categoryData }),
    db.catalogAttributeDefinition.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] }),
    db.categoryAttributeTemplate.findMany({ where: { departmentId: categoryId }, orderBy: [{ position: "asc" }, { attributeId: "asc" }] }),
    categoryAttributes(categoryId, db),
  ]);
  if (!category) throw new CatalogWriteError("not_found", "This category was removed.");
  const sources = [...new Set(effective.map(item => item.sourceDepartmentId))].filter(id => id !== categoryId);
  const inheritedSources = sources.length ? await db.department.findMany({
    where: { id: { in: sources } }, select: { id: true, name: true },
  }) : [];
  return { category, definitions, local, effective, inheritedSources };
}

type Node = { id: string; parentId: string | null };
type Rules = ReadonlyMap<string, CategoryAttributeTemplate>;

function effectiveRule(nodes: ReadonlyMap<string, Node>, id: string, rules: Rules, definition: CatalogAttributeDefinition) {
  const path = departmentAncestorPath(nodes, id)?.reverse() ?? [];
  const rule = path.map(node => rules.get(node.id)).find(template => template && (template.departmentId === id || template.inheritable));
  if (!rule || rule.excluded) return null;
  return { ...definition, sourceDepartmentId: rule.departmentId, position: rule.position, required: rule.required,
    filterable: rule.filterable, inheritable: rule.inheritable } satisfies EffectiveCategoryAttribute;
}

type Input = ReturnType<typeof assignedAttributeValues>;
type ImpactReason = "required" | "invalid_value" | "use_variant_option" | "not_applicable";

function issueChanges(attributeId: string, before: EffectiveCategoryAttribute | null, after: EffectiveCategoryAttribute | null, values: Input) {
  const belongsTo = (value: { attributeId: string }) => value.attributeId === attributeId;
  const issues = (template: EffectiveCategoryAttribute | null) => validateCategoryAttributeValues(template ? [template] : [], values).filter(belongsTo);
  const issueKey = ({ variantId, reason }: { variantId?: string; reason: ImpactReason }) => `${variantId ?? ""}|${reason}`;
  const previous = new Set(issues(before).map(issueKey));
  return [...new Set(issues(after).filter(issue => !previous.has(issueKey(issue))).map(issue => issue.reason))];
}

const impactPageSize = 15;

export async function previewCategoryAttributeImpact(
  actorId: string, raw: unknown, page = 1, database = getDb(),
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new CatalogWriteError("invalid_input", "Choose a valid preview page.");
  const { departmentId, attributeId, expectedRevision, template } = catalogWriteInput(categoryAttributeTemplateInput, raw);
  return database.$transaction(async db => {
    await authorize(db, actorId, true);
    const [categories, definition, templates] = await Promise.all([
      db.department.findMany({ select: categoryData }),
      db.catalogAttributeDefinition.findUnique({ where: { id: attributeId } }),
      db.categoryAttributeTemplate.findMany({ where: { attributeId } }),
    ]);
    const nodes = new Map(categories.map(node => [node.id, node]));
    const category = nodes.get(departmentId);
    if (!category?.kind || category.state === "ARCHIVED" || !definition) {
      throw new CatalogWriteError("not_found", "Choose an editable category and an existing attribute.");
    }
    if (category.revision !== expectedRevision) throw new CatalogWriteError("conflict", "The category changed. Reload and try again.");
    const before = new Map(templates.map(rule => [rule.departmentId, rule]));
    const after = new Map(before);
    if (template) after.set(departmentId, { ...template, departmentId, attributeId });
    else after.delete(departmentId);

    const affected = new Map<string, { before: EffectiveCategoryAttribute | null; after: EffectiveCategoryAttribute | null }>();
    for (const id of departmentFamily(categories, departmentId)) {
      const prior = effectiveRule(nodes, id, before, definition);
      const next = effectiveRule(nodes, id, after, definition);
      // Filterability and ordering do not affect the validity of stored values.
      if (prior?.required !== next?.required) affected.set(id, { before: prior, after: next });
    }

    let total = 0;
    let published = 0;
    const products: { id: string; name: string; isPublished: boolean; reasons: ImpactReason[] }[] = [];
    if (affected.size) {
      let cursor: string | undefined;
      for (;;) {
        const rows = await db.product.findMany({
          where: { departmentId: { in: [...affected.keys()] } }, take: 120, orderBy: { id: "asc" },
          ...(cursor && { cursor: { id: cursor }, skip: 1 }),
          select: { id: true, name: true, departmentId: true, publication: true, active: true, ...assignedAttributeSelection },
        });
        for (const row of rows) {
          const rules = affected.get(row.departmentId)!;
          const reasons = issueChanges(attributeId, rules.before, rules.after, assignedAttributeValues(row));
          if (!reasons.length) continue;
          const isPublished = row.active && row.publication === "ACTIVE";
          if (isPublished) published++;
          if (Math.floor(total / impactPageSize) === page - 1) products.push({ id: row.id, name: row.name, isPublished, reasons });
          total++;
        }
        if (rows.length < 120) break;
        cursor = rows.at(-1)?.id;
      }
    }
    return { total, published, page, pages: Math.max(1, Math.ceil(total / impactPageSize)), products };
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}

export type CategoryAttributeWorkspace = Awaited<ReturnType<typeof categoryAttributeWorkspace>>;
export type CategoryAttributeImpact = Awaited<ReturnType<typeof previewCategoryAttributeImpact>>;
