import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { Prisma, type StaffRole } from "../../generated/prisma/client.ts";
import { canonicalCategoryLocale } from "../catalog/category-presentation.ts";
import { availableMarketMedia } from "../catalog/repository.ts";
import { getDb } from "../db/client.ts";
import { marketIdInput } from "../market-config.ts";
import { catalogImage, productIdField, slugField, textField } from "./catalog-input.ts";
import { missingImage } from "./catalog-media.ts";
import { authorize, OperationError } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";
import { authorizeTaxonomyMarket, lockTaxonomy } from "./taxonomy-write.ts";
import { requireLegacyPilotCategories, requireScopedLegacyWriter, scopedCatalogPilotTargets } from "../catalog/scoped-pilot.ts";

const categoryId = productIdField.refine((id) => id !== "new", "Choose an ID other than new.");
const position = z.number().int().min(0).max(9999);
const revision = z.number().int().min(0).max(2_147_483_646);
const labels = {
  name: textField(2, 100), shortName: textField(2, 32), description: textField(0, 1200),
};
const base = {
  id: categoryId, slug: slugField, name: labels.name, description: labels.description, position,
};
const taxonomyInput = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("department"), shortName: labels.shortName, image: catalogImage, parentId: productIdField.nullable().optional() }),
  z.object({ ...base, kind: z.literal("collection"), image: catalogImage.optional(), selection: z.enum(["CURATED", "NEW", "FEATURED"]) }),
]);

const categoryKind = z.enum(["DEPARTMENT", "CATEGORY", "SUBCATEGORY"]);
const parentKinds = { DEPARTMENT: null, CATEGORY: "DEPARTMENT", SUBCATEGORY: "CATEGORY" } as const;
export const categoryInput = z.strictObject({
  ...base, shortName: labels.shortName, image: catalogImage, kind: categoryKind,
  parentId: categoryId.nullable(), state: z.enum(["DRAFT", "ACTIVE"]), revision: revision.nullable(),
  banner: catalogImage.nullish(), seoTitle: textField(1, 120).nullish(), seoDescription: textField(1, 320).nullish(),
});
const versionedCategory = z.strictObject({ id: categoryId, revision });
const moveInput = versionedCategory.extend({ parentId: categoryId.nullable() });
const siblingOrder = z.strictObject({
  parentId: categoryId.nullable(), siblings: z.array(versionedCategory).min(1).max(10_000),
});
const localeInput = textField(2, 35).transform((input, context) => {
  const locale = canonicalCategoryLocale(input);
  if (locale) return locale;
  context.addIssue({ code: "custom", message: "Enter a valid locale tag." });
  return z.NEVER;
});
const localizedSlug = textField(1, 120).transform((slug) => slug.normalize("NFC").toLowerCase())
  .pipe(z.string().max(120).regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:-[\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u,
    "Use letters or numbers separated by hyphens."));
const translationInput = versionedCategory.extend({
  locale: localeInput,
  translation: z.strictObject({ ...labels, slug: localizedSlug.nullish() }).nullable(),
});
const marketPresentationInput = versionedCategory.extend({
  marketId: marketIdInput,
  presentation: z.strictObject({
    visibleInNavigation: z.boolean().optional(), position: position.optional(), image: catalogImage.optional(),
  }).refine((item) => Object.keys(item).length > 0, "Enter a presentation override or clear it.").nullable(),
});

async function writeTaxonomy<T>(actorId: string, mutation: (tx: Prisma.TransactionClient, role: StaffRole) => Promise<T>, marketId?: MarketId): Promise<T> {
  try {
    return await getDb().$transaction(async (tx) => {
      const staff = marketId ? await authorizeTaxonomyMarket(tx, actorId, marketId) : await authorize(tx, actorId, true);
      await lockTaxonomy(tx);
      return mutation(tx, staff.role);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new CatalogWriteError("conflict", "That ID or URL slug is already in use.");
    }
    throw error;
  }
}

async function audit(tx: Prisma.TransactionClient, actorId: string, target: string, changes: Prisma.InputJsonObject) {
  await tx.auditEvent.create({ data: { actorId, action: "TAXONOMY_SAVED", target, changes } });
}

async function requireImage(tx: Prisma.TransactionClient, image: z.output<typeof catalogImage> | undefined) {
  if (image && await missingImage(tx, [image.src])) throw new OperationError("The image path does not exist.");
}

async function assertParent(
  tx: Prisma.TransactionClient, id: string, parentId: string | null, kind: z.output<typeof categoryKind> | null, active = false,
) {
  if (kind && (parentId === null) !== (kind === "DEPARTMENT")) {
    throw new OperationError("Departments are roots. Choose the direct parent for a category or subcategory.");
  }
  if (!parentId) return;
  const rows = await tx.department.findMany({ select: { id: true, parentId: true, kind: true, state: true } });
  const nodes = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set([id]);
  let currentId: string | null = parentId;
  let expectedKind = kind ? parentKinds[kind] : null;
  while (currentId) {
    if (seen.has(currentId)) throw new OperationError("A category cannot be placed under itself or its descendants.");
    seen.add(currentId);
    const node = nodes.get(currentId);
    if (!node) throw new OperationError("Choose an existing parent category.");
    if (node.kind !== expectedKind) throw new OperationError("Choose a valid parent level.");
    if (node.state === "ARCHIVED" || (active && node.state !== "ACTIVE")) {
      throw new OperationError("Choose an available parent branch. An active category needs active ancestors.");
    }
    expectedKind = node.kind ? parentKinds[node.kind] : null;
    currentId = node.parentId;
  }
  if (expectedKind) throw new OperationError("The parent branch does not reach a department.");
}

async function claimSlug(tx: Prisma.TransactionClient, departmentId: string, locale: string, slug: string) {
  const [canonical, alias, translation] = await Promise.all([
    tx.department.findUnique({ where: { slug }, select: { id: true } }),
    tx.departmentSlugAlias.findFirst({
      where: { slug, departmentId: { not: departmentId }, ...(locale && { locale: { in: ["", locale] } }) },
      select: { departmentId: true },
    }),
    tx.departmentTranslation.findFirst({
      where: { slug, departmentId: { not: departmentId }, ...(locale && { locale }) },
      select: { departmentId: true },
    }),
  ]);
  if ((canonical && canonical.id !== departmentId) || alias || translation) {
    throw new CatalogWriteError("conflict", "That URL slug is already in use or reserved.");
  }
  await tx.departmentSlugAlias.deleteMany({ where: { departmentId, locale, slug } });
}

async function reserveSlug(tx: Prisma.TransactionClient, departmentId: string, locale: string, slug: string) {
  await tx.departmentSlugAlias.upsert({
    where: { locale_slug: { locale, slug } }, create: { departmentId, locale, slug }, update: {},
  });
}

async function editableCategory(tx: Prisma.TransactionClient, id: string, expectedRevision: number) {
  const category = await tx.department.findUnique({ where: { id } });
  if (!category?.kind) throw new CatalogWriteError("not_found", "Choose an existing typed category.");
  if (category.revision !== expectedRevision) throw new CatalogWriteError("conflict", "This category changed. Reload before continuing.");
  if (category.state === "ARCHIVED") throw new CatalogWriteError("conflict", "This category is archived.");
  return category;
}

async function assertCanHideCategory(tx: Prisma.TransactionClient, id: string) {
  const live = { publication: "ACTIVE", active: true } as const;
  const [child, product] = await Promise.all([
    tx.department.findFirst({ where: { parentId: id, state: "ACTIVE" }, select: { id: true } }),
    tx.product.findFirst({
      where: { ...live, OR: [{ departmentId: id }, { secondaryCategories: { some: { departmentId: id } } }] },
      select: { id: true },
    }),
  ]);
  if (child || product) throw new OperationError("Reassign or retire active products and child categories before hiding this category.");
}

export async function saveCategory(actorId: string, raw: unknown) {
  const input = catalogWriteInput(categoryInput, raw);
  const { id, revision: expectedRevision, image, banner, seoTitle, seoDescription, ...fields } = input;
  return writeTaxonomy(actorId, async (tx) => {
    const previous = expectedRevision === null ? null : await editableCategory(tx, id, expectedRevision);
    if (previous && previous.kind !== fields.kind) throw new OperationError("An existing category level cannot change.");
    await assertParent(tx, id, fields.parentId, fields.kind, fields.state === "ACTIVE");
    if (previous?.state === "ACTIVE" && fields.state === "DRAFT") await assertCanHideCategory(tx, id);
    await requireImage(tx, image);
    await requireImage(tx, banner ?? undefined);
    await claimSlug(tx, id, "", fields.slug);
    if (previous && previous.slug !== fields.slug) await reserveSlug(tx, id, "", previous.slug);
    const data = { ...fields, imageSrc: image.src, imageAlt: image.alt,
      ...(banner !== undefined && { bannerSrc: banner?.src ?? null, bannerAlt: banner?.alt ?? null }),
      ...(seoTitle !== undefined && { seoTitle }), ...(seoDescription !== undefined && { seoDescription }),
    };
    const category = previous
      ? await tx.department.update({ where: { id }, data: { ...data, revision: { increment: 1 } } })
      : await tx.department.create({ data: { ...data, id } });
    await audit(tx, actorId, id, {
      kind: fields.kind, previousParentId: previous?.parentId ?? null, parentId: fields.parentId,
      previousSlug: previous?.slug ?? null, slug: fields.slug, state: fields.state, revision: category.revision,
      name: fields.name, shortName: fields.shortName, description: fields.description, position: fields.position,
      image: { src: category.imageSrc, alt: category.imageAlt },
      banner: category.bannerSrc && category.bannerAlt ? { src: category.bannerSrc, alt: category.bannerAlt } : null,
      seoTitle: category.seoTitle, seoDescription: category.seoDescription,
    });
    return category;
  });
}

export async function moveCategory(actorId: string, raw: unknown) {
  const { id, revision: expectedRevision, parentId } = catalogWriteInput(moveInput, raw);
  return writeTaxonomy(actorId, async tx => {
    const previous = await editableCategory(tx, id, expectedRevision);
    await assertParent(tx, id, parentId, previous.kind, previous.state === "ACTIVE");
    if (previous.parentId === parentId) return previous;
    const category = await tx.department.update({ where: { id }, data: { parentId, revision: { increment: 1 } } });
    await audit(tx, actorId, id, { previousParentId: previous.parentId, parentId, revision: category.revision });
    return category;
  });
}

export async function archiveCategory(actorId: string, raw: unknown) {
  const { id, revision: expectedRevision } = catalogWriteInput(versionedCategory, raw);
  return writeTaxonomy(actorId, async (tx) => {
    await editableCategory(tx, id, expectedRevision);
    await assertCanHideCategory(tx, id);
    const category = await tx.department.update({ where: { id }, data: { state: "ARCHIVED", revision: { increment: 1 } } });
    await audit(tx, actorId, id, { state: category.state, revision: category.revision });
    return category;
  });
}

export async function reorderCategories(actorId: string, raw: unknown) {
  const { parentId, siblings } = catalogWriteInput(siblingOrder, raw);
  return writeTaxonomy(actorId, async (tx) => {
    const saved = await tx.department.findMany({
      where: { parentId, kind: { not: null }, state: { not: "ARCHIVED" } }, select: { id: true, revision: true },
    });
    const byId = new Map(saved.map((item) => [item.id, item.revision]));
    if (new Set(siblings.map(({ id }) => id)).size !== byId.size || siblings.length !== byId.size ||
      siblings.some(({ id, revision }) => byId.get(id) !== revision)) {
      throw new CatalogWriteError("conflict", "The category siblings changed. Reload before reordering.");
    }
    const result = await Promise.all(siblings.map(({ id }, index) => tx.department.update({
      where: { id }, data: { position: index, revision: { increment: 1 } }, select: { id: true, position: true, revision: true },
    })));
    await audit(tx, actorId, parentId ?? "category-roots", { siblings: result });
    return result;
  });
}

export async function saveCategoryTranslation(actorId: string, raw: unknown) {
  const { id, revision: expectedRevision, locale, translation } = catalogWriteInput(translationInput, raw);
  return writeTaxonomy(actorId, async (tx) => {
    await editableCategory(tx, id, expectedRevision);
    const key = { departmentId: id, locale };
    const where = { departmentId_locale: key };
    const previous = await tx.departmentTranslation.findUnique({ where, select: { slug: true } });
    if (translation?.slug) await claimSlug(tx, id, locale, translation.slug);
    if (previous?.slug && previous.slug !== translation?.slug) await reserveSlug(tx, id, locale, previous.slug);
    if (translation) {
      const data = { ...translation, slug: translation.slug ?? null };
      await tx.departmentTranslation.upsert({ where, create: { ...key, ...data }, update: data });
    } else {
      await tx.departmentTranslation.deleteMany({ where: key });
    }
    const category = await tx.department.update({ where: { id }, data: { revision: { increment: 1 } } });
    await audit(tx, actorId, id, { locale, previousSlug: previous?.slug ?? null, slug: translation?.slug ?? null,
      removed: translation === null, revision: category.revision });
    return category;
  });
}

export async function saveCategoryMarketPresentation(actorId: string, raw: unknown, nativePilot = false) {
  const { id, revision: expectedRevision, marketId, presentation } = catalogWriteInput(marketPresentationInput, raw);
  return writeTaxonomy(actorId, async (tx, role) => {
    if (nativePilot) {
      const reviewed = await scopedCatalogPilotTargets(tx);
      if (!reviewed) throw new CatalogWriteError("unavailable", "The reviewed catalog pilot is unavailable.");
      if (reviewed.categoryIds.includes(id)) {
        throw new CatalogWriteError("forbidden", "Use the main GriipBuddy admin for this catalog category.");
      }
    }
    await editableCategory(tx, id, expectedRevision);
    const key = { departmentId: id, marketId };
    if (presentation) {
      await requireImage(tx, presentation.image);
      if (role !== "OWNER" && presentation.image?.src.startsWith("/media/")) {
        const { src } = presentation.image;
        const existing = await tx.departmentMarketPresentation.findUnique({ where: { departmentId_marketId: key }, select: { imageSrc: true } });
        if (existing?.imageSrc !== src && !(await availableMarketMedia([src], marketId, tx)).has(src)) {
          throw new CatalogWriteError("forbidden", "Choose an image already approved for this market.");
        }
      }
      const data = {
        visibleInNavigation: presentation.visibleInNavigation ?? null, position: presentation.position ?? null,
        imageSrc: presentation.image?.src ?? null, imageAlt: presentation.image?.alt ?? null,
      };
      await tx.departmentMarketPresentation.upsert({
        where: { departmentId_marketId: key }, create: { ...key, ...data }, update: data,
      });
    } else {
      await tx.departmentMarketPresentation.deleteMany({ where: key });
    }
    const category = await tx.department.update({ where: { id }, data: { revision: { increment: 1 } } });
    await audit(tx, actorId, id, { marketId, visibleInNavigation: presentation?.visibleInNavigation ?? null,
      position: presentation?.position ?? null, image: presentation?.image ?? null,
      removed: presentation === null, revision: category.revision });
    return category;
  }, marketId);
}

export async function saveTaxonomy(actorId: string, raw: unknown, existingId: string | null) {
  const value = catalogWriteInput(taxonomyInput, raw);
  if (existingId !== null && existingId !== value.id) throw new OperationError("An existing ID cannot change.");
  await writeTaxonomy(actorId, async (tx) => {
    const legacyPilot = await requireScopedLegacyWriter(tx);
    if (legacyPilot) {
      if (value.kind !== "department" || !existingId) {
        throw new OperationError("Use the main GriipBuddy admin to create categories or manage collections.");
      }
      await requireLegacyPilotCategories(tx, [existingId, value.parentId]);
    }
    const fields = { slug: value.slug, name: value.name, description: value.description, position: value.position };
    await requireImage(tx, value.image);
    if (value.kind === "department") {
      const previous = existingId && await tx.department.findUnique({ where: { id: existingId } });
      if (previous && previous.kind) throw new OperationError("Use typed category operations to edit this category.");
      if (legacyPilot && previous && value.parentId !== undefined && previous.parentId !== value.parentId) {
        await requireLegacyPilotCategories(tx, [previous.parentId]);
      }
      await assertParent(tx, value.id, value.parentId ?? null, null);
      await claimSlug(tx, value.id, "", value.slug);
      if (previous && previous.slug !== value.slug) await reserveSlug(tx, value.id, "", previous.slug);
      const data = { ...fields, shortName: value.shortName, imageSrc: value.image.src, imageAlt: value.image.alt, parentId: value.parentId };
      if (existingId) await tx.department.update({ where: { id: existingId }, data });
      else await tx.department.create({ data: { ...data, id: value.id } });
    } else {
      const data = { ...fields, selection: value.selection, imageSrc: value.image?.src ?? null, imageAlt: value.image?.alt ?? null };
      if (existingId) await tx.collection.update({ where: { id: existingId }, data: { ...data, revision: { increment: 1 } } });
      else await tx.collection.create({ data: { ...data, id: value.id } });
    }
    await audit(tx, actorId, value.id, {
      kind: value.kind, slug: value.slug, ...(value.kind === "department" && value.parentId !== undefined && { parentId: value.parentId }),
    });
  });
}
