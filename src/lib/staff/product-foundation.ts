import { Prisma } from "../../generated/prisma/client.ts";
import { categoryAttributes, validateCategoryAttributeValues } from "../catalog/category-attributes.ts";
import { variantOptionSignature } from "../catalog/option-signature.ts";
import { getDb } from "../db/client.ts";
import { productionMode } from "../release-config.ts";
import { lockCatalogProductQuoteRows } from "./catalog-locks.ts";
import { authorize, lockProductEdits, OperationError } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";
import { productFoundationInput, type ProductFoundationInput } from "./product-foundation-input.ts";
import { categoryPlacementScope, lockTaxonomy } from "./taxonomy-write.ts";

type Tx = Prisma.TransactionClient;
type AttributeValues = NonNullable<ProductFoundationInput["attributeValues"]>;
const productRelations = {
  secondaryCategories: { select: { departmentId: true } },
  variants: {
    select: { id: true, sku: true, optionSignature: true, archivedAt: true, position: true,
      attributeValues: true, gtin: true, mpn: true, identifiersNotAssigned: true },
  },
} as const satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productRelations }>;

export async function ownerProductFoundation(actorId: string, productId: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  const byPosition = [{ position: "asc" }, { id: "asc" }] as const;
  return db.product.findFirst({
    where: { id: productId, foundation: true },
    include: {
      secondaryCategories: { orderBy: { departmentId: "asc" }, select: { departmentId: true } },
      translations: { orderBy: { locale: "asc" } },
      images: { orderBy: { position: "asc" } },
      optionDefinitions: { orderBy: [...byPosition], include: { values: { orderBy: [...byPosition] } } },
      variants: { orderBy: [...byPosition], include: {
        optionSelections: { orderBy: { optionId: "asc" }, select: { optionId: true, optionValueId: true } },
        images: { orderBy: { position: "asc" } },
        compatibility: { orderBy: { modelId: "asc" }, select: { modelId: true } },
        offers: { orderBy: { marketId: "asc" }, select: { marketId: true, currency: true, amountMinor: true, publication: true, eligible: true } },
      } },
    },
  });
}

function storedValues(json: Prisma.JsonValue | undefined): AttributeValues {
  return (json as AttributeValues | null | undefined) ?? {};
}

async function validatePlacements(tx: Tx, input: ProductFoundationInput, current: ProductRow | null) {
  const secondary = input.secondaryCategoryIds ?? current?.secondaryCategories.map(row => row.departmentId) ?? [];
  const categories = [input.primaryCategoryId, ...secondary];
  if (new Set(categories).size !== categories.length) throw new OperationError("Choose each category only once.");
  if (await tx.department.count({ where: categoryPlacementScope(categories, false) }) !== categories.length) {
    throw new OperationError("Choose active subcategories with active ancestors for catalog placements.");
  }
  return secondary;
}

function prepareVariants(input: ProductFoundationInput, current: ProductRow | null) {
  const previous = new Map(current?.variants.map(row => [row.id, row]));
  const next = new Set(input.variants.map(row => row.id));
  if (current?.variants.some(row => !next.has(row.id))) {
    throw new OperationError("Archive an issued variant instead of removing it.");
  }
  const defaultVariantId = input.defaultVariantId ?? (input.options.length === 0
    ? input.variants.find(row => row.active)?.id : undefined);
  const retiredAt = new Date();
  return input.variants.map((row, position) => {
    const prior = previous.get(row.id);
    const optionSignature = variantOptionSignature(row.selections);
    if (prior && (row.sku !== prior.sku || optionSignature !== prior.optionSignature)) {
      throw new OperationError("An issued variant keeps its SKU and option combination.");
    }
    if (row.active && prior?.archivedAt) throw new OperationError("An archived variant cannot be reactivated.");
    if (!row.active && !prior) throw new OperationError("New variants must be explicitly enabled. Omit combinations that are unavailable.");

    const selected = input.options.map(option => ({
      key: option.key, optionId: option.id, value: option.values.find(value => value.id === row.selections[option.id])!,
    }));
    const gtin = row.gtin === undefined ? prior?.gtin ?? null : row.gtin;
    const mpn = row.mpn === undefined ? prior?.mpn ?? null : row.mpn;
    const identifiersNotAssigned = row.identifiersNotAssigned ?? prior?.identifiersNotAssigned ?? false;
    if (identifiersNotAssigned && (gtin || mpn)) {
      throw new OperationError("Remove the GTIN and manufacturer part number before marking identifiers as unassigned.");
    }
    return {
      id: row.id, sku: row.sku, selected,
      data: {
        active: row.active, archivedAt: row.active ? null : prior?.archivedAt ?? retiredAt,
        isDefault: row.active && row.id === defaultVariantId, optionSignature,
        options: Object.fromEntries(selected.map(({ key, value }) => [key, value.label])),
        label: selected.map(({ value }) => value.label).join(" / ") || "Standard",
        position: !row.active && prior ? prior.position : position,
        attributeValues: row.attributeValues ?? storedValues(prior?.attributeValues),
        gtin, mpn, identifiersNotAssigned,
      },
    };
  });
}

async function validateAttributes(
  tx: Tx, input: ProductFoundationInput, variants: ReturnType<typeof prepareVariants>, productValues: AttributeValues,
) {
  const templates = await categoryAttributes(input.primaryCategoryId, tx);
  const bound = new Map(templates.filter(row => row.variantOptionKey).map(row => [row.variantOptionKey, row]));
  for (const option of input.options) {
    const template = bound.get(option.key);
    if (template?.dataType === "ENUM" && option.values.some(value => !template.allowedValues.includes(value.value))) {
      throw new OperationError(`Option ${option.key} has a value outside the category template.`);
    }
  }
  const issues = validateCategoryAttributeValues(templates, {
    productValues,
    variants: variants.map(({ id, selected, data }) => ({
      id, active: data.active, values: data.attributeValues,
      options: Object.fromEntries(selected.map(({ key, value }) => [key, value.value])),
    })),
  }).filter(issue => input.publication === "ACTIVE" || issue.reason !== "required");
  if (issues.length) {
    const summary = issues.slice(0, 8).map(issue =>
      `${issue.variantId ? `${issue.variantId} / ` : ""}${issue.attributeId} (${issue.reason.replaceAll("_", " ")})`);
    throw new OperationError(`Check the category attributes. ${summary.join(" · ")}`);
  }
}

async function saveOptions(tx: Tx, input: ProductFoundationInput, hasIssuedVariants: boolean) {
  const productId = input.id;
  const previous = await tx.productOption.findMany({ where: { productId }, include: { values: true } });
  const requested = new Map(input.options.map(option => [option.id, option]));
  if (hasIssuedVariants && (input.options.length !== previous.length || previous.some(row => !requested.has(row.id)))) {
    throw new OperationError("An issued variant keeps its option dimensions.");
  }
  for (const prior of previous) {
    const option = requested.get(prior.id);
    if (!option) {
      await tx.productOptionValue.deleteMany({ where: { productId, optionId: prior.id } });
      await tx.productOption.delete({ where: { productId_id: { productId, id: prior.id } } });
      continue;
    }
    if (option.key !== prior.key) throw new OperationError("An option keeps its key. Edit its display label instead.");
    const previousValues = new Map(prior.values.map(value => [value.id, value.value]));
    if (option.values.some(value => previousValues.has(value.id) && previousValues.get(value.id) !== value.value)) {
      throw new OperationError("An option value keeps its canonical value. Edit its display label instead.");
    }
    const retained = new Set(option.values.map(value => value.id));
    const removed = prior.values.filter(value => !retained.has(value.id)).map(value => value.id);
    if (removed.length) {
      await tx.productOptionValue.deleteMany({ where: { productId, optionId: prior.id, id: { in: removed } } });
    }
  }
  for (const [position, { id, key, label, values }] of input.options.entries()) {
    await tx.productOption.upsert({
      where: { productId_id: { productId, id } },
      create: { productId, id, key, label, position },
      update: { label, position },
    });
    for (const [position, { id: valueId, value, label }] of values.entries()) {
      await tx.productOptionValue.upsert({
        where: { productId_optionId_id: { productId, optionId: id, id: valueId } },
        create: { productId, optionId: id, id: valueId, value, label, position },
        update: { label, position },
      });
    }
  }
}

async function saveVariants(tx: Tx, productId: string, variants: ReturnType<typeof prepareVariants>, current: ProductRow | null) {
  const issued = new Set(current?.variants.map(row => row.id));
  const nextDefault = variants.find(row => row.data.isDefault)?.id;
  await tx.variant.updateMany({
    where: { productId, isDefault: true, ...(nextDefault && { id: { not: nextDefault } }) }, data: { isDefault: false },
  });
  for (const { id, sku, data, selected } of variants) {
    if (issued.has(id)) {
      await tx.variant.update({ where: { id }, data });
    } else {
      await tx.variant.create({ data: { id, productId, sku, ...data } });
      if (selected.length) await tx.variantOptionSelection.createMany({
        data: selected.map(({ optionId, value }) => ({ variantId: id, productId, optionId, optionValueId: value.id })),
      });
    }
  }
}

async function validateProductionMedia(tx: Tx, productId: string) {
  const media = await tx.product.findUnique({
    where: { id: productId },
    select: { demo: true, images: { select: { src: true } }, variants: {
      select: { imageSrc: true, images: { select: { src: true } } },
    } },
  });
  if (media?.demo) throw new OperationError("Use staging for sample products.");
  if (!media?.images.length || [...media.images.map(image => image.src), ...media.variants.flatMap(row =>
    [...(row.imageSrc ? [row.imageSrc] : []), ...row.images.map(image => image.src)],
  )].some(src => !src.startsWith("/media/"))) {
    throw new OperationError("Upload approved product images before publishing in production.");
  }
}

export async function saveProductFoundation(actorId: string, raw: unknown,
  validatePublication?: (db: Prisma.TransactionClient, id: string) => Promise<void>) {
  const input = catalogWriteInput(productFoundationInput, raw);
  const { id, expectedRevision, primaryCategoryId, publication } = input;
  try {
    return await getDb().$transaction(async tx => {
      await authorize(tx, actorId, true);
      await lockTaxonomy(tx);
      await lockProductEdits(tx, id);
      await lockCatalogProductQuoteRows(tx, id);
      const current = await tx.product.findUnique({ where: { id }, include: productRelations });
      if (current && !current.foundation) throw new CatalogWriteError("conflict", "This product still uses the legacy catalog editor.");
      if ((current?.revision ?? null) !== expectedRevision) throw new CatalogWriteError("conflict", "This product changed. Reload before saving.");
      if (current && input.slug !== current.slug) throw new OperationError("The product URL stays stable after creation.");
      if (publication === "ACTIVE" && productionMode()) await validateProductionMedia(tx, id);
      const secondary = await validatePlacements(tx, input, current);
      const variants = prepareVariants(input, current);
      const attributeValues = input.attributeValues ?? storedValues(current?.attributeValues);
      await validateAttributes(tx, input, variants, attributeValues);
      if (await tx.variant.findFirst({
        where: { productId: { not: id }, OR: [
          { id: { in: variants.map(row => row.id) } },
          { sku: { in: variants.map(row => row.sku), mode: "insensitive" } },
        ] },
        select: { id: true },
      })) throw new CatalogWriteError("conflict", "A variant ID or SKU already belongs to another product.");

      const priorSecondary = current?.secondaryCategories.map(row => row.departmentId) ?? [];
      const desiredSet = new Set(secondary);
      const replaceSecondary = current?.departmentId !== primaryCategoryId || priorSecondary.length !== desiredSet.size ||
        priorSecondary.some(categoryId => !desiredSet.has(categoryId));
      if (current && replaceSecondary) await tx.productSecondaryCategory.deleteMany({ where: { productId: id } });
      const { name, description } = input;
      const data = {
        name, description, departmentId: primaryCategoryId, publication, active: publication === "ACTIVE", attributeValues,
        ...(input.brand !== undefined && { brand: input.brand }),
        ...(input.shortDescription !== undefined && { shortDescription: input.shortDescription || null }),
        ...(input.specifications !== undefined && { specifications: input.specifications }),
        ...(input.keywords !== undefined && { keywords: input.keywords }),
      };
      const product = current
        ? await tx.product.update({ where: { id }, data: { ...data, revision: { increment: 1 } }, select: { id: true, revision: true } })
        : await tx.product.create({
          data: { specifications: [], keywords: [], ...data, id, slug: input.slug, foundation: true, position: 10_000, addedOn: new Date() },
          select: { id: true, revision: true },
        });
      if (replaceSecondary && secondary.length) {
        await tx.productSecondaryCategory.createMany({ data: secondary.map(departmentId =>
          ({ productId: id, primaryDepartmentId: primaryCategoryId, departmentId })) });
      }
      await saveOptions(tx, input, Boolean(current?.variants.length));
      await saveVariants(tx, id, variants, current);
      if (publication === "ACTIVE" && current?.publication !== "ACTIVE") await validatePublication?.(tx, id);
      const changedFields = [
        ["Title", current?.name, data.name], ["Description", current?.description, data.description],
        ["Short description", current?.shortDescription, data.shortDescription], ["Brand", current?.brand, data.brand],
        ["Specifications", current?.specifications, data.specifications], ["Attributes", current?.attributeValues, data.attributeValues],
        ["Keywords", current?.keywords, data.keywords],
      ].filter(([, before, after]) => after !== undefined && JSON.stringify(before) !== JSON.stringify(after))
        .map(([field]) => String(field));
      if (replaceSecondary) changedFields.push("Categories");
      await tx.auditEvent.create({
        data: { actorId, action: "PRODUCT_SAVED", target: id,
          changes: { source: "foundation", publication, revision: product.revision, primaryCategoryId, changedFields,
            secondaryCategoryIds: secondary, variants: variants.map(row => ({
              id: row.id, sku: row.sku, active: row.data.active, label: row.data.label, default: row.data.isDefault,
            })) } },
      });
      return product;
    }, { timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new CatalogWriteError("conflict", "The product URL, identity, SKU or option combination is already assigned.");
    }
    throw error;
  }
}
