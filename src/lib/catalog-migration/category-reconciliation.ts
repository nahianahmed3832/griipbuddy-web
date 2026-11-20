import { z } from "zod";
import type { DepartmentKind, Prisma } from "../../generated/prisma/client.ts";
import { canonicalCategoryLocale } from "../catalog/category-locale.ts";
import {
  categoryBusinessCode, categoryCodeEntity, categoryCodeNamespace, recoveredCategoryId, recoveredCategorySource,
} from "../catalog/category-reference.ts";
import { departmentAncestorPath } from "../catalog/departments.ts";
import type { DbReader } from "../db/client.ts";
import { productIdField, textField } from "../staff/catalog-input.ts";
import type { CategoryManifest } from "./catalog.ts";
import { migrationDigest, type MigrationIssue, type MigrationMapping } from "./contracts.ts";

const levels = {
  categories: { target: "DEPARTMENT", parent: null },
  subcategories: { target: "CATEGORY", parent: "categories" },
  sub_subcategories: { target: "SUBCATEGORY", parent: "subcategories" },
  third_subcategories: { target: null, parent: "sub_subcategories" },
} as const;

const objectId = z.string().regex(recoveredCategoryId);
const locale = z.string().max(35).refine(value => canonicalCategoryLocale(value) === value, "Use a canonical locale tag.");
const slug = z.string().max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:-[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u)
  .refine(value => value === value.normalize("NFC").toLowerCase(), "Use the existing normalized URL slug.");

export const legacyCategoryInput = z.strictObject({
  collection: z.enum(["categories", "subcategories", "sub_subcategories", "third_subcategories"]),
  sourceId: objectId,
  sourceParentId: objectId.nullable(),
  targetId: productIdField,
  evidence: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,159}$/),
  codes: z.array(z.strictObject({ namespace: z.string().regex(categoryCodeNamespace), value: z.string().regex(categoryBusinessCode) })).max(8).optional(),
  aliases: z.array(z.strictObject({ locale: z.union([z.literal(""), locale]), slug })).max(12).optional(),
  translations: z.array(z.strictObject({ locale, name: textField(2, 100), shortName: textField(2, 32), description: textField(0, 1200),
    slug: slug.nullable(), })).max(12).optional(),
});
export type LegacyCategory = z.output<typeof legacyCategoryInput>;

type SlugClaim = { departmentId: string; locale: string; slug: string };
const nodeFields = { id: true, parentId: true, kind: true, state: true, slug: true, revision: true } as const;
const expectedPath: Record<DepartmentKind, DepartmentKind[]> = {
  DEPARTMENT: ["DEPARTMENT"], CATEGORY: ["DEPARTMENT", "CATEGORY"], SUBCATEGORY: ["DEPARTMENT", "CATEGORY", "SUBCATEGORY"],
};
const external = (entity: string, sourceId: string, targetId: string): MigrationMapping =>
  ({ sourceSystem: recoveredCategorySource, entity, sourceId, targetId });
const byField = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function namedSlugs<T extends { slug: string | null }>(rows: readonly T[]) {
  return rows.flatMap(row => row.slug ? [{ ...row, slug: row.slug }] : []);
}

export async function inspectLegacyCategories(db: DbReader, input: readonly LegacyCategory[], native: readonly CategoryManifest[]) {
  const references = [...input].sort((a, b) => byField(a.sourceId, b.sourceId));
  const sourceIds = new Map(references.map(row => [row.sourceId, row]));
  const targetIds = [...new Set(references.map(row => row.targetId))];
  const requestedTranslations = references.flatMap(row => row.translations?.map(value => ({ ...value, departmentId: row.targetId })) ?? []);
  const requestedAliases = references.flatMap(row => row.aliases?.map(value => ({ ...value, departmentId: row.targetId })) ?? []);
  const requestedClaims = [...requestedAliases, ...namedSlugs(requestedTranslations)];
  const requestedSlugs = [...new Set([...requestedClaims.map(row => row.slug), ...sourceIds.keys()])];
  const existingNodes = await db.department.findMany({ select: nodeFields, orderBy: { id: "asc" } });
  const oldToNew = await db.catalogMigrationMapping.findMany({
    where: { sourceSystem: recoveredCategorySource, entity: "category", targetId: { in: targetIds } },
    select: { sourceId: true, targetId: true }, orderBy: { sourceId: "asc" },
  });
  const existingTranslations = await db.departmentTranslation.findMany({
    where: { OR: [{ departmentId: { in: targetIds } }, { slug: { in: requestedSlugs } }] },
    orderBy: [{ departmentId: "asc" }, { locale: "asc" }],
  });
  const existingAliases = await db.departmentSlugAlias.findMany({
    where: { slug: { in: requestedSlugs } }, orderBy: [{ slug: "asc" }, { locale: "asc" }],
  });

  const issues: MigrationIssue[] = [];
  const issue = (code: string, reference: string, message: string) => issues.push({ code, reference, message });
  if (sourceIds.size !== references.length) issue("duplicate-category-source", "legacyCategories", "Review each recovered category identifier once.");
  if (targetIds.length !== references.length) issue("ambiguous-category-target", "legacyCategories", "Several recovered categories point at one canonical category. Review the identities separately.");
  const instructions = new Map(native.map(row => [row.id, row]));
  const nodes = new Map(existingNodes.map(node => [node.id, { ...node, ...instructions.get(node.id) }]));
  const mappings: MigrationMapping[] = [];
  const claimedCodes = new Set<string>();
  for (const row of references) {
    const level = levels[row.collection];
    const target = nodes.get(row.targetId);
    const parent = row.sourceParentId === null ? null : sourceIds.get(row.sourceParentId);
    const path = target && departmentAncestorPath(nodes, target.id);
    const expected = level.target && expectedPath[level.target];
    if (!level.target) issue("unsupported-category-depth", row.sourceId, "The source is a fourth-level category. Preserve the original branch until its canonical hierarchy is explicitly supported.");
    else if (!target || !path || !expected || path.length !== expected.length || path.some((node, index) =>
      node.kind !== expected[index] || target.state === "ACTIVE" && node.state !== "ACTIVE")) {
      issue("invalid-canonical-category", row.sourceId, "Choose an existing or reviewed native category with the corresponding available hierarchy.");
    }
    if (level.parent === null ? row.sourceParentId !== null || target?.parentId !== null
      : !parent || parent.collection !== level.parent || parent.targetId !== target?.parentId) {
      issue("category-parent-conflict", row.sourceId, "Review the source parent and its canonical counterpart together before mapping this category.");
    }
    if (oldToNew.some(saved => saved.targetId === row.targetId && saved.sourceId !== row.sourceId)) {
      issue("ambiguous-category-target", row.sourceId, "The canonical category already has a different reviewed recovered identity.");
    }
    mappings.push(external("category", row.sourceId, row.targetId));
    for (const code of row.codes ?? []) {
      const entity = categoryCodeEntity(code.namespace);
      const key = `${entity}\0${code.value}`;
      if (claimedCodes.has(key)) issue("category-code-conflict", row.sourceId, "Review each namespaced business code once.");
      claimedCodes.add(key);
      mappings.push(external(entity, code.value, row.targetId));
    }
  }

  const claims: SlugClaim[] = [
    ...existingNodes.map(row => ({ departmentId: row.id, locale: "", slug: row.slug })),
    ...existingAliases,
    ...namedSlugs(existingTranslations),
  ];
  const bySlug = new Map<string, SlugClaim[]>();
  for (const claim of claims) {
    const entries = bySlug.get(claim.slug) ?? [];
    entries.push(claim);
    bySlug.set(claim.slug, entries);
  }
  for (const claim of requestedClaims) {
    const entries = bySlug.get(claim.slug) ?? [];
    if (entries.some(row => row.departmentId !== claim.departmentId && (!row.locale || !claim.locale || row.locale === claim.locale))) {
      issue("category-slug-conflict", claim.slug, "The legacy URL belongs to a different canonical category or translation. Review the conflict before applying.");
    }
    entries.push(claim);
    bySlug.set(claim.slug, entries);
  }
  for (const row of references) {
    if ((nodes.has(row.sourceId) && row.sourceId !== row.targetId) ||
        bySlug.get(row.sourceId)?.some(claim => claim.departmentId !== row.targetId)) {
      issue("category-reference-conflict", row.sourceId, "A native ID or URL already uses this recovered category identifier.");
    }
  }

  const translationKeys = new Set<string>();
  const translations = requestedTranslations.filter(row => {
    const key = `${row.departmentId}\0${row.locale}`;
    const existing = existingTranslations.find(value => value.departmentId === row.departmentId && value.locale === row.locale);
    if (translationKeys.has(key) || existing && migrationDigest(existing) !== migrationDigest(row)) {
      issue("category-translation-conflict", row.departmentId, "A canonical translation differs from the reviewed source. Retain and review both versions before applying.");
    }
    translationKeys.add(key);
    return !existing;
  });
  const aliasKeys = new Set<string>();
  const aliases = requestedAliases.filter(row => {
    const key = `${row.locale}\0${row.slug}`;
    const exists = aliasKeys.has(key) || existingAliases.some(alias => alias.locale === row.locale && alias.slug === row.slug) ||
      nodes.get(row.departmentId)?.slug === row.slug ||
      [...existingTranslations, ...translations].some(translation => translation.departmentId === row.departmentId &&
        translation.locale === row.locale && translation.slug === row.slug);
    aliasKeys.add(key);
    return !exists;
  });
  return { issues, mappings, aliases, translations, source: { existingNodes, oldToNew, existingTranslations, existingAliases } };
}

export async function applyLegacyCategoryPresentation(tx: Prisma.TransactionClient, plan: Awaited<ReturnType<typeof inspectLegacyCategories>>) {
  if (plan.issues.length) throw new Error("Resolve the reviewed category conflicts first.");
  if (plan.translations.length) await tx.departmentTranslation.createMany({ data: plan.translations });
  if (plan.aliases.length) await tx.departmentSlugAlias.createMany({ data: plan.aliases });
  const ids = [...new Set([...plan.translations, ...plan.aliases].map(row => row.departmentId))];
  if (ids.length) await tx.department.updateMany({ where: { id: { in: ids } }, data: { revision: { increment: 1 } } });
}
