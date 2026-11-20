import { createHash } from "node:crypto";
import { z } from "zod";
import type { DepartmentKind, Prisma } from "../../generated/prisma/client.ts";
import { validVariantId } from "../cart/model.ts";
import { validateCategoryAttributeValues, type EffectiveCategoryAttribute } from "../catalog/category-attributes.ts";
import { departmentAncestorPath } from "../catalog/departments.ts";
import { maxProductOptions, variantOptionSignature } from "../catalog/option-signature.ts";
import type { DbReader } from "../db/client.ts";
import { MAX_GALLERY_IMAGES, catalogImage, productIdField, skuField, slugField, textField } from "../staff/catalog-input.ts";
import { missingImage } from "../staff/catalog-media.ts";
import { migrationDigest, nativeSourceSystem, type MigrationIssue, type MigrationMapping } from "./contracts.ts";

type Tx = Prisma.TransactionClient;
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;
const compound = (...parts: (string | number)[]) => JSON.stringify(parts);
const map = (entity: string, sourceId: string, targetId = sourceId): MigrationMapping =>
  ({ sourceSystem: nativeSourceSystem, entity, sourceId, targetId });

export const categoryManifestInput = z.strictObject({
  id: productIdField,
  kind: z.enum(["DEPARTMENT", "CATEGORY", "SUBCATEGORY"]),
  parentId: productIdField.nullable(),
});
export type CategoryManifest = z.infer<typeof categoryManifestInput>;

const evidenceInput = z.strictObject({
  kind: z.enum(["supplier-parent", "manufacturer-variants", "purchasing-record"]),
  reference: z.string().trim().regex(/^[\p{L}\p{N}][\p{L}\p{N} ._:/#-]{2,159}$/u),
});
const variantIdInput = z.string().refine(validVariantId);
const optionValuesInput = z.record(textField(1, 40), textField(1, 70))
  .refine(values => Object.keys(values).length <= maxProductOptions);

export const productManifestInput = z.strictObject({
  targetProductId: productIdField,
  sourceProductIds: z.array(productIdField).min(1).max(20),
  primaryCategoryId: productIdField,
  secondaryCategoryIds: z.array(productIdField).max(50).optional(),
  defaultVariantId: variantIdInput.optional(),
  groupingEvidence: evidenceInput.optional(),
  variantOptions: z.array(z.strictObject({ variantId: variantIdInput, options: optionValuesInput, evidence: evidenceInput })).max(100).optional(),
  compatibility: z.array(z.strictObject({
    variantId: variantIdInput, modelIds: z.array(productIdField).min(1).max(50).refine(unique), evidence: evidenceInput,
  })).max(100).optional(),
  verifiedSimple: z.strictObject({ variantId: variantIdInput, sku: skuField, evidence: evidenceInput }).optional(),
});
export type ProductManifest = z.infer<typeof productManifestInput>;

const categoryFields = {
  id: true, slug: true, parentId: true, kind: true, state: true, revision: true, imageSrc: true, imageAlt: true,
} as const satisfies Prisma.DepartmentSelect;
type Department = Prisma.DepartmentGetPayload<{ select: typeof categoryFields }>;
const expectedPath: Record<DepartmentKind, DepartmentKind[]> = {
  DEPARTMENT: ["DEPARTMENT"], CATEGORY: ["DEPARTMENT", "CATEGORY"], SUBCATEGORY: ["DEPARTMENT", "CATEGORY", "SUBCATEGORY"],
};

function projectCategories(rows: Department[], instructions: readonly CategoryManifest[]) {
  const changes = new Map(instructions.map(change => [change.id, change]));
  return new Map(rows.map(row => [row.id, { ...row, ...changes.get(row.id) }]));
}

function validCategoryPath(nodes: ReadonlyMap<string, Department>, id: string): Department[] | null {
  const path = departmentAncestorPath(nodes, id);
  const kind = path?.at(-1)?.kind;
  return kind && path?.length === expectedPath[kind].length &&
    path.every((row, index) => row.kind === expectedPath[kind][index]) ? path : null;
}

async function unavailableMedia(db: DbReader, images: Iterable<string>) {
  const missing: string[] = [];
  for (const src of [...new Set(images)].sort()) {
    if (await missingImage(db, [src])) missing.push(src);
  }
  return missing;
}

export async function inspectCategories(db: DbReader, instructions: readonly CategoryManifest[]) {
  const changes = [...instructions].sort(byId);
  const rows = await db.department.findMany({ select: categoryFields, orderBy: { id: "asc" } });
  const current = new Map(rows.map(row => [row.id, row]));
  const projected = projectCategories(rows, changes);
  const issues: MigrationIssue[] = [];
  if (!unique(changes.map(row => row.id))) issues.push({
    code: "CATEGORY_MAPPING_CONFLICT", reference: "categories", message: "A category has more than one proposed mapping.",
  });
  for (const { id, kind, parentId } of changes) {
    const issue = (code: string, message: string) => issues.push({ code, reference: id, message });
    const before = current.get(id);
    const path = validCategoryPath(projected, id);
    if (!before) issue("MISSING_CATEGORY", "The legacy category does not exist.");
    else if (before.kind && (before.kind !== kind || before.parentId !== parentId)) {
      issue("CATEGORY_MAPPING_CONFLICT", "The proposal changes an already typed category.");
    } else if (!path || (before.state === "ACTIVE" && path.some(node => node.state !== "ACTIVE"))) {
      issue("INVALID_CATEGORY_PATH", "The reviewed category path has a missing, circular, inactive, or incompatible ancestor.");
    }
  }
  // Reparenting an untyped legacy node must also keep all typed descendants valid.
  for (const row of projected.values()) {
    if (row.kind && current.get(row.id)?.kind && !validCategoryPath(projected, row.id)) issues.push({
      code: "INVALID_EXISTING_CATEGORY_PATH", reference: row.id, message: "The category plan would leave a typed category without its required ancestors.",
    });
  }
  const missing = await unavailableMedia(db, changes.flatMap(({ id }) => current.get(id)?.imageSrc ? [current.get(id)!.imageSrc] : []));
  for (const row of rows.filter(row => changes.some(change => change.id === row.id) && missing.includes(row.imageSrc))) {
    issues.push({ code: "MISSING_CATEGORY_MEDIA", reference: row.id, message: "The category image is unavailable on this copy." });
  }
  return { source: { rows, missing }, issues, changes };
}

export async function applyCategories(tx: Tx, plan: Awaited<ReturnType<typeof inspectCategories>>): Promise<MigrationMapping[]> {
  if (plan.issues.length) throw new Error("Unresolved category migration conflicts.");
  const prior = new Map(plan.source.rows.map(row => [row.id, row]));
  for (const { id, kind, parentId } of plan.changes) {
    const before = prior.get(id);
    if (before?.kind === kind && before.parentId === parentId) continue;
    await tx.department.update({ where: { id }, data: { kind, parentId, revision: { increment: 1 } } });
  }
  return plan.changes.map(({ id }) => map("category", id));
}

const productRelations = {
  images: { orderBy: { position: "asc" } },
  collections: { orderBy: { collectionId: "asc" } },
  secondaryCategories: { orderBy: { departmentId: "asc" } },
  optionDefinitions: { orderBy: { id: "asc" }, include: { values: { orderBy: { id: "asc" } } } },
  variants: {
    orderBy: { id: "asc" },
    include: {
      optionSelections: { orderBy: { optionId: "asc" } },
      images: { orderBy: { position: "asc" } },
      compatibility: { orderBy: { modelId: "asc" } },
    },
  },
} as const satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productRelations }>;
type VariantRow = ProductRow["variants"][number];
type SourceVariant = Pick<VariantRow, "id" | "productId" | "sku" | "options" | "label" | "position" | "active" | "attributeValues" |
  "archivedAt" | "optionSignature" | "imageSrc" | "imageAlt" | "images" | "compatibility" | "optionSelections"> & { synthesized?: true };

const stableId = (kind: "o" | "v", ...values: string[]) =>
  `${kind}-${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 30)}`;
const folded = (value: string) => value.normalize("NFKC").toLowerCase();

function readLegacyOptions(value: unknown) {
  const parsed = optionValuesInput.safeParse(value);
  if (!parsed.success || typeof value !== "object" || !value ||
      Object.entries(value).some(([key, label]) => parsed.data[key] !== label)) return null;
  return parsed.data;
}

async function effectiveTemplates(db: DbReader, path: readonly Department[]): Promise<EffectiveCategoryAttribute[]> {
  const rules = await db.categoryAttributeTemplate.findMany({
    where: { departmentId: { in: path.map(row => row.id) } },
    include: { attribute: true },
    orderBy: [{ departmentId: "asc" }, { attributeId: "asc" }],
  });
  const nearest = new Map<string, typeof rules[number]>();
  for (const [index, ancestor] of [...path].reverse().entries()) {
    for (const rule of rules.filter(({ departmentId }) => departmentId === ancestor.id)) {
      if ((index === 0 || rule.inheritable) && !nearest.has(rule.attributeId)) nearest.set(rule.attributeId, rule);
    }
  }
  return [...nearest.values()].filter(rule => !rule.excluded).map(rule => ({
    ...rule.attribute, sourceDepartmentId: rule.departmentId, required: rule.required, filterable: rule.filterable,
    position: rule.position, inheritable: rule.inheritable,
  }));
}

function propertyValues(value: Prisma.JsonValue | null): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function prepareOptions(
  productId: string, variants: { row: SourceVariant; options: Record<string, string> }[], issues: MigrationIssue[],
) {
  const keys = [...new Set(variants.flatMap(item => Object.keys(item.options)))].sort();
  if (keys.length > maxProductOptions || !unique(keys.map(folded)) ||
    variants.some(item => Object.keys(item.options).length !== keys.length)) {
    issues.push({
      code: "INCONSISTENT_OPTIONS", reference: productId, message: "Supply verified option values for every variant on a consistent axis set.",
    });
  }
  const options = keys.map((key, position) => {
    const values = [...new Set(variants.flatMap(item => item.options[key] === undefined ? [] : [item.options[key]]))].sort();
    if (values.length > 60 || !unique(values.map(folded))) issues.push({
      code: "AMBIGUOUS_OPTION_LABEL", reference: productId, message: "Distinct source values collide after option label normalization or exceed the supported list.",
    });
    return {
      id: stableId("o", productId, key), key, label: key, position,
      values: values.map((value, position) => ({ id: stableId("v", productId, key, value), value, label: value, position })),
    };
  });
  const seen = new Map<string, string>();
  const plannedVariants = variants.map(({ row, options: values }) => {
    const selected = options.flatMap(option => {
      const value = option.values.find(value => value.value === values[option.key]);
      return value ? [{ option, value }] : [];
    });
    const signature = variantOptionSignature(Object.fromEntries(selected.map(({ option, value }) => [option.id, value.id])));
    if (seen.has(signature)) issues.push({
      code: "DUPLICATE_OPTION_COMBINATION", reference: row.id,
      message: `This physical variant has the same verified option combination as ${seen.get(signature)}.`,
    });
    seen.set(signature, row.id);
    return { row, options: values, selected, signature };
  });
  return { options, plannedVariants };
}

function prepareGallery(target: ProductRow | undefined, products: ProductRow[], issues: MigrationIssue[]) {
  const gallery = (target?.images ?? []).map(image => ({ ...image }));
  const refs = new Map(gallery.map(image => [image.src, image.position]));
  let nextPosition = Math.max(-1, ...gallery.map(image => image.position)) + 1;
  for (const product of products.filter(row => row.id !== target?.id)) {
    for (const image of product.images) {
      const priorPosition = refs.get(image.src);
      if (priorPosition !== undefined) {
        if (gallery.find(row => row.position === priorPosition)?.alt !== image.alt) issues.push({
          code: "CONFLICTING_GALLERY_METADATA", reference: product.id,
          message: "A shared gallery asset has conflicting accessibility text across the source listings.",
        });
        continue;
      }
      refs.set(image.src, nextPosition);
      gallery.push({ ...image, position: nextPosition++, productId: target?.id ?? "", isPrimary: false });
    }
  }
  if (gallery.length > MAX_GALLERY_IMAGES) issues.push({
    code: "GALLERY_LIMIT", reference: target?.id ?? "catalog", message: "The grouped gallery exceeds the supported photo count.",
  });
  if (gallery.length && !gallery.some(image => image.isPrimary)) gallery[0].isPrimary = true;
  return { gallery, refs };
}

function productMappings(
  instruction: ProductManifest,
  target: ProductRow,
  products: ProductRow[],
  variants: ReturnType<typeof prepareOptions>["plannedVariants"],
  refs: ReadonlyMap<string, number>,
  secondaryCategoryIds: string[],
) {
  const productId = target.id;
  const mappings: MigrationMapping[] = [];
  for (const { row, selected } of variants) {
    mappings.push(row.synthesized ? map("verified-simple-variant", row.productId, row.id) : map("variant", row.id));
    if (row.sku) mappings.push(map("sku", row.sku, row.id));
    for (const { option, value } of selected) {
      mappings.push(map("option", compound(row.productId, option.key), compound(productId, option.id)));
      mappings.push(map("option-value", compound(row.productId, option.key, value.value), compound(productId, option.id, value.id)));
    }
    if (row.imageSrc && row.imageAlt && !row.images.length) mappings.push(map("variant-image", row.id, compound(row.id, 0)));
    for (const { position } of row.images) mappings.push(map("variant-image", compound(row.id, position)));
    const fit = instruction.compatibility?.find(item => item.variantId === row.id);
    for (const modelId of [...row.compatibility.map(item => item.modelId), ...(fit?.modelIds ?? [])]) {
      mappings.push(map("variant-compatibility", compound(row.id, modelId)));
    }
  }
  const { primaryCategoryId } = instruction;
  const retainedCategories = new Set([primaryCategoryId, ...secondaryCategoryIds]);
  for (const source of products) {
    const category = retainedCategories.has(source.departmentId) ? source.departmentId : primaryCategoryId;
    mappings.push(
      map("product", source.id, productId), map("product-slug", source.slug, target.slug),
      map("product-primary-category", compound(source.id, source.departmentId), compound(productId, category)),
    );
    for (const { departmentId } of source.secondaryCategories.filter(row => retainedCategories.has(row.departmentId))) {
      mappings.push(map("product-secondary-category", compound(source.id, departmentId), compound(productId, departmentId)));
    }
    for (const image of source.images) {
      mappings.push(map("product-image", compound(source.id, image.position),
        compound(productId, source.id === productId ? image.position : refs.get(image.src)!)));
    }
  }
  return [...new Map(mappings.map(item => [compound(item.entity, item.sourceId), item])).values()];
}

export async function inspectProducts(db: DbReader, instruction: ProductManifest, categories: readonly CategoryManifest[] = []) {
  const { targetProductId, sourceProductIds, primaryCategoryId, groupingEvidence, verifiedSimple } = instruction;
  const products = await db.product.findMany({
    where: { id: { in: sourceProductIds } }, include: productRelations, orderBy: { id: "asc" },
  });
  const categoriesView = projectCategories(await db.department.findMany({ select: categoryFields, orderBy: { id: "asc" } }), categories);
  const target = products.find(row => row.id === targetProductId);
  const issues: MigrationIssue[] = [];
  const issue = (code: string, message: string, reference = targetProductId) => issues.push({ code, reference, message });
  if (!target || !unique(sourceProductIds) || products.length !== sourceProductIds.length) {
    issue("PRODUCT_MAPPING_CONFLICT", "Every source must exist once and the retained parent must be one of those sources.");
  }
  if (sourceProductIds.length > 1 && !groupingEvidence) {
    issue("AMBIGUOUS_PRODUCT_GROUP", "Grouping requires a reviewed supplier parent, manufacturer variant document, or purchasing record.");
  }
  if (products.some(row => row.foundation || row.optionDefinitions.length)) {
    issue("PRODUCT_ALREADY_CONNECTED", "A structured product cannot be overwritten by a legacy conversion.");
  }
  for (const row of products) {
    if (slugField.safeParse(row.slug).data !== row.slug) issue("INVALID_PRODUCT_SLUG", "A legacy product URL is invalid and needs review.", row.id);
    if (target && (row.marketplaceShopId !== target.marketplaceShopId || row.brand !== target.brand ||
      row.publication !== target.publication || row.active !== target.active || row.demo !== target.demo ||
      row.personalizationPrompt !== target.personalizationPrompt || row.personalizationRequired !== target.personalizationRequired)) {
      issue("PRODUCT_GROUP_TERMS_CONFLICT", "Grouped parents must agree on seller, brand, publication and personalization.", row.id);
    }
  }
  const aliases = await db.catalogMigrationRedirect.findMany({
    where: { OR: [{ slug: { in: products.map(row => row.slug) } }, { sourceProductId: { in: sourceProductIds } }] },
    orderBy: { slug: "asc" },
  });
  if (aliases.some(alias => alias.productId !== targetProductId ||
    !products.some(row => row.id !== targetProductId && row.slug === alias.slug && row.id === alias.sourceProductId))) {
    issue("PRODUCT_URL_MAPPING_CONFLICT", "A source URL was already mapped to a different product.");
  }
  const activeLeaf = (id: string) => categoriesView.get(id)?.kind === "SUBCATEGORY" &&
    validCategoryPath(categoriesView, id)?.every(row => row.state === "ACTIVE");
  const placements = instruction.secondaryCategoryIds ?? [];
  if (!unique([primaryCategoryId, ...placements]) || ![primaryCategoryId, ...placements].every(activeLeaf)) {
    issue("INVALID_PRODUCT_CATEGORY", "Primary and additional categories must be distinct reviewed active leaves.");
  }
  const retained = products.flatMap(row => [row.departmentId, ...row.secondaryCategories.map(item => item.departmentId)]);
  const secondaryCategoryIds = [...new Set([...placements, ...retained.filter(activeLeaf)])].filter(id => id !== primaryCategoryId).sort();
  if (secondaryCategoryIds.length > 50) issue("CATEGORY_LIMIT", "The group exceeds the supported number of additional categories.");

  const sourceVariants: SourceVariant[] = products.flatMap(row => row.variants).sort(byId);
  const assignedVariantIds = new Set(sourceVariants.map(row => row.id));
  const synthesizedCollision = verifiedSimple ? await db.variant.findUnique({ where: { id: verifiedSimple.variantId }, select: { id: true } }) : null;
  if (verifiedSimple) {
    if (sourceProductIds.length !== 1 || sourceVariants.length || synthesizedCollision || !target) {
      issue("SIMPLE_VARIANT_CONFLICT", "A verified simple SKU can only supply the sole variant of a source product without variant rows.");
    } else {
      sourceVariants.push({
        id: verifiedSimple.variantId, productId: target.id, sku: verifiedSimple.sku, options: {}, label: "Standard", position: 0,
        active: target.publication !== "ARCHIVED", attributeValues: null, archivedAt: null, optionSignature: null,
        imageSrc: null, imageAlt: null, images: [], compatibility: [], optionSelections: [], synthesized: true,
      });
      assignedVariantIds.add(verifiedSimple.variantId);
    }
  }
  if (!sourceVariants.length) issue("MISSING_SKU", "No physical variant exists. Supply an explicitly verified SKU for a simple product.");
  if (sourceVariants.length > 40) issue("VARIANT_LIMIT", "The group exceeds the catalog's supported variant count.");

  const overrides = instruction.variantOptions ?? [];
  const fitment = instruction.compatibility ?? [];
  for (const rules of [overrides, fitment]) {
    if (!unique(rules.map(rule => rule.variantId)) || rules.some(rule => !assignedVariantIds.has(rule.variantId))) {
      issue("VARIANT_MAPPING_CONFLICT", "Verified options and fitment must reference a single variant within the scoped product group.");
    }
  }
  const modelIds = [...new Set(fitment.flatMap(rule => rule.modelIds))];
  const approvedModels = await db.deviceModel.findMany({
    where: { id: { in: modelIds } }, select: { id: true, lookupKey: true, revision: true }, orderBy: { id: "asc" },
  });
  if (approvedModels.length !== modelIds.length) issue("MISSING_DEVICE_MODEL", "A fitment link refers to an unapproved or absent device model.");

  const externalSkus = await db.variant.findMany({
    where: { sku: { in: sourceVariants.map(row => row.sku), mode: "insensitive" }, id: { notIn: [...assignedVariantIds] } },
    select: { id: true, sku: true }, orderBy: { id: "asc" },
  });
  if (externalSkus.length || !unique(sourceVariants.map(row => folded(row.sku)))) {
    issue("DUPLICATE_SKU", "A stable SKU collides with another physical variant.");
  }
  const parsedOptions = sourceVariants.map(row => {
    if (!row.sku) issue("MISSING_SKU", "The physical variant is missing its SKU.", row.id);
    else if (skuField.safeParse(row.sku).data !== row.sku || !validVariantId(row.id)) {
      issue("INVALID_LEGACY_VARIANT_IDENTITY", "The retained variant ID or SKU requires explicit reconciliation.", row.id);
    }
    if (row.optionSignature !== null || row.optionSelections.length) {
      issue("VARIANT_ALREADY_CONNECTED", "Existing normalized variant selections cannot be overwritten.", row.id);
    }
    const override = overrides.find(rule => rule.variantId === row.id);
    const options = override?.options ?? readLegacyOptions(row.options);
    if (!options) issue("INVALID_VARIANT_OPTIONS", "The legacy option data needs verified, explicit values.", row.id);
    return { row, options: options ?? {} };
  });
  const { options, plannedVariants } = prepareOptions(targetProductId, parsedOptions, issues);
  const order = [...plannedVariants].sort((a, b) => {
    const rank = Number(a.row.productId !== targetProductId) - Number(b.row.productId !== targetProductId);
    return rank || a.row.productId.localeCompare(b.row.productId, "en") || a.row.position - b.row.position || byId(a.row, b.row);
  });
  let appendedPosition = Math.max(-1, ...target?.variants.map(row => row.position) ?? []) + 1;
  const orderedVariants = order.map(variant => ({
    ...variant, position: variant.row.productId === targetProductId ? variant.row.position : appendedPosition++,
  }));
  if (orderedVariants.some(row => row.position < 0 || row.position > 2_147_483_647)) {
    issue("INVALID_VARIANT_POSITION", "A retained or grouped variant needs a valid display order.");
  }
  const active = sourceVariants.filter(row => row.active);
  const defaultVariantId = instruction.defaultVariantId ?? (active.length === 1 ? active[0].id : undefined);
  if ((defaultVariantId && !active.some(row => row.id === defaultVariantId)) ||
    (!defaultVariantId && (active.length > 1 || target?.publication === "ACTIVE"))) {
    issue("MISSING_VARIANT_DEFAULT", "Choose a verified active default variant for this product.");
  }

  const primaryPath = validCategoryPath(categoriesView, primaryCategoryId) ?? [];
  const templates = await effectiveTemplates(db, primaryPath);
  const invalidAttributes = validateCategoryAttributeValues(templates, {
    productValues: propertyValues(target?.attributeValues ?? null),
    variants: parsedOptions.map(({ row, options }) => ({
      id: row.id, active: row.active, options, values: propertyValues(row.attributeValues),
    })),
  }).filter(item => item.reason !== "required" || target?.publication === "ACTIVE");
  for (const invalid of invalidAttributes) {
    issue("CATEGORY_ATTRIBUTE_CONFLICT", `Category attribute ${invalid.attributeId} requires review (${invalid.reason}).`, invalid.variantId);
  }

  const { gallery, refs } = prepareGallery(target, products, issues);
  const images = [
    ...products.flatMap(product => product.images),
    ...sourceVariants.flatMap(row => [...row.images, ...(!row.imageSrc && !row.imageAlt ? [] : [{ src: row.imageSrc, alt: row.imageAlt }])]),
  ];
  const invalidMedia = images.some(({ src, alt }) => !catalogImage.safeParse({ src, alt }).success);
  const missingMedia = await unavailableMedia(db, images.flatMap(image => image.src ? [image.src] : []));
  if (invalidMedia || missingMedia.length) {
    issue("MISSING_PRODUCT_MEDIA", "The group has unavailable image assets or invalid image metadata.");
  }
  const relevantCategories = [...new Set([primaryCategoryId, ...placements, ...retained])].sort().map(id => ({
    id,
    path: (validCategoryPath(categoriesView, id) ?? []).map(({ id, kind, parentId, state }) => ({ id, kind, parentId, state })),
  }));
  return {
    source: { products, aliases, relevantCategories, templates, approvedModels, externalSkus, synthesizedCollision, missingMedia },
    issues, target, options, plannedVariants: orderedVariants, secondaryCategoryIds, gallery, defaultVariantId, instruction,
    mappings: target ? productMappings(instruction, target, products, orderedVariants, refs, secondaryCategoryIds) : [],
    sourceVariantIds: products.flatMap(product => product.variants.map(variant => variant.id)).sort(),
    targetVariantIds: sourceVariants.map(row => row.id).sort(),
  };
}

export async function applyProducts(tx: Tx, plan: Awaited<ReturnType<typeof inspectProducts>>): Promise<MigrationMapping[]> {
  if (plan.issues.length || !plan.target) throw new Error("Unresolved product migration conflicts.");
  const { target, instruction, gallery } = plan;
  const productId = target.id;

  await tx.productSecondaryCategory.deleteMany({ where: { productId } });
  await tx.product.update({
    where: { id: productId }, data: { departmentId: instruction.primaryCategoryId, foundation: true, revision: { increment: 1 } },
  });
  await tx.productSecondaryCategory.createMany({ data: plan.secondaryCategoryIds.map(departmentId => ({
    productId, departmentId, primaryDepartmentId: instruction.primaryCategoryId,
  })) });
  for (const { values, ...option } of plan.options) {
    await tx.productOption.create({ data: { ...option, productId, values: { createMany: { data: values } } } });
  }
  for (const { row, signature, selected, options, position } of plan.plannedVariants) {
    const changes = { productId, optionSignature: signature, isDefault: row.id === plan.defaultVariantId, position, options };
    if (row.synthesized) {
      await tx.variant.create({ data: { ...changes, id: row.id, label: row.label, sku: row.sku, active: row.active } });
    } else {
      await tx.variant.update({ where: { id: row.id }, data: changes });
    }
    await tx.variantOptionSelection.createMany({ data: selected.map(({ option, value }) => ({
      productId, variantId: row.id, optionId: option.id, optionValueId: value.id,
    })) });
    if (row.imageSrc && row.imageAlt && !row.images.length) {
      await tx.variantImage.create({ data: { variantId: row.id, position: 0, src: row.imageSrc, alt: row.imageAlt, isPrimary: true } });
    }
    const fit = instruction.compatibility?.find(fit => fit.variantId === row.id);
    if (fit) {
      await tx.variantCompatibility.createMany({
        data: fit.modelIds.map(modelId => ({ variantId: row.id, modelId })), skipDuplicates: true,
      });
    }
  }
  for (const image of gallery) {
    const before = target.images.find(row => row.position === image.position);
    if (!before) await tx.productImage.create({ data: image });
    else if (before.isPrimary !== image.isPrimary) {
      await tx.productImage.update({
        where: { productId_position: { productId, position: image.position } }, data: { isPrimary: image.isPrimary },
      });
    }
  }
  for (const source of plan.source.products) {
    if (source.id === productId) continue;
    await tx.collectionProduct.createMany({
      data: source.collections.map(({ collectionId, position }) => ({ productId, collectionId, position })), skipDuplicates: true,
    });
    if (!plan.source.aliases.some(alias => alias.slug === source.slug)) {
      await tx.catalogMigrationRedirect.create({ data: { slug: source.slug, productId, sourceProductId: source.id } });
    }
    await tx.product.update({
      where: { id: source.id }, data: { active: false, publication: "ARCHIVED", revision: { increment: 1 } },
    });
  }
  return plan.mappings;
}

export async function reconcileCatalogProduct(db: DbReader, plan: Awaited<ReturnType<typeof inspectProducts>>) {
  const productId = plan.instruction.targetProductId;
  const product = await db.product.findUnique({ where: { id: productId }, include: productRelations });
  const mismatch = () => new Error(`Converted product ${productId} failed catalog reconciliation.`);
  const photoKey = (image: { src: string; alt: string; position: number; isPrimary: boolean }) =>
    migrationDigest([image.src, image.alt, image.position, image.isPrimary]);
  if (!product?.foundation || !plan.target || product.slug !== plan.target.slug ||
    product.departmentId !== plan.instruction.primaryCategoryId ||
    product.variants.length !== plan.plannedVariants.length ||
    product.images.length !== plan.gallery.length ||
    compound(...product.secondaryCategories.map(row => row.departmentId)) !== compound(...plan.secondaryCategoryIds)) throw mismatch();
  const actualOptions = product.optionDefinitions.map(({ id, key, label, position, values }) => ({
    id, key, label, position, values: values.map(({ id, value, label, position }) => ({ id, value, label, position })),
  }));
  const expectedOptions = [...plan.options].sort(byId).map(option => ({ ...option, values: [...option.values].sort(byId) }));
  if (migrationDigest(actualOptions) !== migrationDigest(expectedOptions)) throw mismatch();
  const actualVariants = new Map(product.variants.map(row => [row.id, row]));
  for (const { row, signature, selected, position, options } of plan.plannedVariants) {
    const actual = actualVariants.get(row.id);
    if (!actual || actual.sku !== row.sku || actual.label !== row.label || actual.active !== row.active ||
      actual.imageSrc !== row.imageSrc || actual.imageAlt !== row.imageAlt || actual.position !== position ||
      actual.isDefault !== (row.id === plan.defaultVariantId) || actual.optionSignature !== signature ||
      migrationDigest(actual.options) !== migrationDigest(options) ||
      variantOptionSignature(Object.fromEntries(actual.optionSelections.map(value => [value.optionId, value.optionValueId]))) !== signature ||
      actual.optionSelections.length !== selected.length) throw mismatch();
    const photos = row.images.length || !row.imageSrc || !row.imageAlt ? row.images : [
      { src: row.imageSrc, alt: row.imageAlt, position: 0, isPrimary: true },
    ];
    if (compound(...actual.images.map(photoKey)) !== compound(...photos.map(photoKey))) throw mismatch();
    const models = new Set([
      ...row.compatibility.map(item => item.modelId),
      ...(plan.instruction.compatibility?.find(fit => fit.variantId === row.id)?.modelIds ?? []),
    ]);
    if (actual.compatibility.length !== models.size || actual.compatibility.some(item => !models.has(item.modelId))) throw mismatch();
  }
  if (compound(...product.images.map(photoKey)) !== compound(...plan.gallery.map(photoKey))) throw mismatch();
  const grouped = plan.source.products.filter(row => row.id !== productId);
  const predecessors = await db.product.findMany({
    where: { id: { in: grouped.map(row => row.id) } }, select: { active: true, publication: true, _count: { select: { variants: true } } },
  });
  if (predecessors.length !== grouped.length ||
    predecessors.some(row => row.active || row.publication !== "ARCHIVED" || row._count.variants !== 0)) throw mismatch();
  const redirects = await db.catalogMigrationRedirect.findMany({ where: { sourceProductId: { in: grouped.map(row => row.id) } } });
  if (redirects.length !== grouped.length || redirects.some(redirect => redirect.productId !== productId ||
    !grouped.some(row => row.id === redirect.sourceProductId && row.slug === redirect.slug))) throw mismatch();
  return {
    sourceProducts: plan.source.products.length,
    connectedProducts: 1,
    sourceVariants: plan.sourceVariantIds.length,
    connectedVariants: product.variants.length,
    groupedProducts: grouped.length,
    mediaReferences: product.images.length + product.variants.reduce((total, variant) => total + variant.images.length, 0),
    redirectCount: redirects.length,
  };
}
