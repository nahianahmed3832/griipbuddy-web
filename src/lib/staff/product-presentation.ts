import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { canonicalCategoryLocale } from "../catalog/category-locale.ts";
import { catalogGalleryOrder } from "../catalog/product-presentation.ts";
import { validVariantId } from "../cart/model.ts";
import { getDb } from "../db/client.ts";
import { productionMode } from "../release-config.ts";
import { catalogImage, MAX_GALLERY_IMAGES, productIdField, textField } from "./catalog-input.ts";
import { missingImage } from "./catalog-media.ts";
import { authorize, lockProductEdits, OperationError } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";

const productEdit = z.strictObject({ productId: productIdField, revision: z.number().int().min(0).max(2_147_483_646) });
const galleryFields = { src: true, alt: true, position: true, isPrimary: true } as const;
const galleryInput = productEdit.extend({
  variantId: z.string().refine(validVariantId, "Choose a valid variant ID.").optional(),
  images: z.array(catalogImage.extend({ isPrimary: z.boolean().optional() })).max(MAX_GALLERY_IMAGES),
}).superRefine(({ images }, context) => {
  if (new Set(images.map(({ src }) => src)).size !== images.length) {
    context.addIssue({ code: "custom", path: ["images"], message: "Use each gallery image once." });
  }
  if (images.filter(({ isPrimary }) => isPrimary).length > 1) {
    context.addIssue({ code: "custom", path: ["images"], message: "Choose one primary gallery image." });
  }
});

const translationInput = productEdit.extend({
  locale: textField(2, 35).transform((value, context) => {
    const canonical = canonicalCategoryLocale(value);
    if (canonical) return canonical;
    context.addIssue({ code: "custom", message: "Enter a valid locale tag." });
    return z.NEVER;
  }),
  content: z.strictObject({
    name: textField(2, 120), description: textField(1, 4000), shortDescription: textField(1, 240).nullish(),
  }).nullable(),
});

async function editPresentation<T>(
  actorId: string, edit: z.output<typeof productEdit>,
  write: (tx: Prisma.TransactionClient, active: boolean) => Promise<{ changes: Prisma.InputJsonObject; result: T }>,
) {
  const { productId, revision } = edit;
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockProductEdits(tx, productId);
    const product = await tx.product.findUnique({
      where: { id: productId }, select: { foundation: true, publication: true, revision: true },
    });
    if (!product?.foundation) throw new CatalogWriteError("not_found", "Choose a product managed by the catalog foundation.");
    if (product.publication === "ARCHIVED") throw new CatalogWriteError("conflict", "This product is archived.");
    if (product.revision !== revision) throw new CatalogWriteError("conflict", "This product changed. Reload before editing it.");
    const { changes, result } = await write(tx, product.publication === "ACTIVE");
    const updated = await tx.product.updateMany({ where: { id: productId, revision }, data: { revision: { increment: 1 } } });
    if (updated.count !== 1) throw new CatalogWriteError("conflict", "This product changed. Reload before editing it.");
    await tx.auditEvent.create({ data: {
      actorId, action: "PRODUCT_SAVED", target: productId, changes: { ...changes, revision: revision + 1 },
    } });
    return { productId, revision: revision + 1, result };
  });
}

export async function saveProductGallery(actorId: string, raw: unknown) {
  const edit = catalogWriteInput(galleryInput, raw);
  const { productId, variantId, images } = edit;
  const gallery = catalogGalleryOrder(images.map((image, position) => ({ ...image, position })))
    .map(({ src, alt }, position) => ({ src, alt, position, isPrimary: position === 0 }));
  return editPresentation(actorId, edit, async (tx, active) => {
    if (productionMode() && active && ((!variantId && !gallery.length) || gallery.some(({ src }) => !src.startsWith("/media/")))) {
      throw new OperationError("Upload approved product images before publishing in production.");
    }
    if (await missingImage(tx, gallery.map(({ src }) => src))) {
      throw new OperationError("An image path does not exist. Upload the image or select a bundled catalog image.");
    }
    const orderBy = { position: "asc" } as const;
    let before;
    if (variantId) {
      // Update the legacy projection before the parent revision to match checkout's lock order.
      const updated = await tx.variant.updateMany({ where: { id: variantId, productId, archivedAt: null, optionSignature: { not: null } },
        data: { imageSrc: gallery[0]?.src ?? null, imageAlt: gallery[0]?.alt ?? null },
      });
      if (updated.count !== 1) throw new CatalogWriteError("not_found", "Choose a variant of this product that has not been archived.");
      before = await tx.variantImage.findMany({ where: { variantId }, select: galleryFields, orderBy });
      await tx.variantImage.deleteMany({ where: { variantId } });
      if (gallery.length) await tx.variantImage.createMany({ data: gallery.map(image => ({ ...image, variantId })) });
    } else {
      before = await tx.productImage.findMany({ where: { productId }, select: galleryFields, orderBy });
      await tx.productImage.deleteMany({ where: { productId } });
      if (gallery.length) await tx.productImage.createMany({ data: gallery.map(image => ({ ...image, productId })) });
    }
    return { changes: { kind: "gallery", variantId: variantId ?? null, sources: gallery.map(({ src }) => src), before, after: gallery }, result: gallery };
  });
}

export async function saveProductTranslation(actorId: string, raw: unknown) {
  const edit = catalogWriteInput(translationInput, raw);
  const { productId, locale, content } = edit;
  const translation = content && { name: content.name, description: content.description, shortDescription: content.shortDescription ?? null };
  return editPresentation(actorId, edit, async tx => {
    const key = { productId, locale };
    const before = await tx.productTranslation.findUnique({
      where: { productId_locale: key }, select: { name: true, description: true, shortDescription: true },
    });
    if (translation) await tx.productTranslation.upsert({
      where: { productId_locale: key }, create: { ...key, ...translation }, update: translation,
    });
    else await tx.productTranslation.deleteMany({ where: key });
    return { changes: { kind: "translation", locale, removed: translation === null, before, after: translation }, result: translation && { locale, ...translation } };
  });
}
