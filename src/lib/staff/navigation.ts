import { z } from "zod";
import { catalogVariantWhere } from "../catalog/connected-public.ts";
import { connectedCollectionProductFilter, orderedCollectionProducts, publicCollectionScope } from "../catalog/collection-selection.ts";
import { getDb } from "../db/client.ts";
import { marketConfiguration, marketIdInput, marketLanguage } from "../market-config.ts";
import { catalogImage, productIdField, slugField, textField } from "./catalog-input.ts";
import { missingImage } from "./catalog-media.ts";
import { authorize, OperationError } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";
import { authorizeTaxonomyMarket, lockTaxonomy } from "./taxonomy-write.ts";

const revision = z.int().min(0).max(2_147_483_646);
const menuFields = { label: textField(1, 80).regex(/^[^<>\p{Cc}]+$/u).nullish(), visible: z.boolean().default(true) };
const itemInput = z.discriminatedUnion("type", [
  z.strictObject({ ...menuFields, type: z.literal("category"), categoryId: productIdField }),
  z.strictObject({ ...menuFields, type: z.literal("collection"), collectionId: productIdField }),
  z.strictObject({ ...menuFields, type: z.literal("page"), page: z.enum(["HOME", "SEARCH", "SHOP"]) }),
]);
const menuInput = z.strictObject({
  marketId: marketIdInput, key: slugField, locale: textField(0, 35).default(""),
  expectedRevision: revision.nullable(), items: z.array(itemInput).max(100),
});

export type EditableMarketMenuItem = z.output<typeof itemInput>;

export async function saveMarketMenu(actorId: string, raw: unknown) {
  const { marketId, key, locale: requestedLocale, expectedRevision, items } = catalogWriteInput(menuInput, raw);
  const locale = requestedLocale ? marketLanguage(marketConfiguration(marketId), requestedLocale) : "";
  if (locale === undefined) throw new CatalogWriteError("invalid_input", "Select a language configured for this market.");
  return getDb().$transaction(async tx => {
    await authorizeTaxonomyMarket(tx, actorId, marketId);
    await lockTaxonomy(tx);
    const current = await tx.marketMenu.findUnique({
      where: { marketId_key_locale: { marketId, key, locale } }, select: { id: true, revision: true },
    });
    if ((current?.revision ?? null) !== expectedRevision) throw new CatalogWriteError("conflict", "The menu changed. Reload it and try again.");

    const categories = [...new Set(items.flatMap(item => item.type === "category" ? [item.categoryId] : []))];
    const collections = [...new Set(items.flatMap(item => item.type === "collection" ? [item.collectionId] : []))];
    const visible = [...new Set(items.flatMap(item => item.type === "collection" && item.visible ? [item.collectionId] : []))];
    if (categories.length && await tx.department.count({ where: { id: { in: categories } } }) !== categories.length) {
      throw new OperationError("A menu category does not exist.");
    }
    if (collections.length && await tx.collection.count({ where: { id: { in: collections } } }) !== collections.length) {
      throw new OperationError("A menu collection does not exist.");
    }
    if (visible.length && await tx.collection.count({ where: { id: { in: visible }, ...publicCollectionScope(marketId) } }) !== visible.length) {
      throw new OperationError("Publish the collection in this market or hide its menu link before saving.");
    }

    const menu = current
      ? await tx.marketMenu.update({ where: { id: current.id }, data: { revision: { increment: 1 } }, select: { id: true, revision: true } })
      : await tx.marketMenu.create({ data: { marketId, key, locale, revision: 1 }, select: { id: true, revision: true } });
    if (current) await tx.marketMenuItem.deleteMany({ where: { menuId: menu.id } });
    if (items.length) await tx.marketMenuItem.createMany({ data: items.map((item, position) => ({
      menuId: menu.id, position, label: item.label ?? null, visible: item.visible,
      ...(item.type === "category" ? { departmentId: item.categoryId }
        : item.type === "collection" ? { collectionId: item.collectionId } : { page: item.page }),
    })) });
    await tx.auditEvent.create({ data: { actorId, action: "TAXONOMY_SAVED", target: menu.id,
      changes: { kind: "market-menu", marketId, key, locale, revision: menu.revision, items },
    } });
    return menu;
  });
}

const collectionSaveInput = z.strictObject({
  id: productIdField.refine(id => id !== "new", "Choose an ID other than new."),
  expectedRevision: revision.nullable(), name: textField(2, 100), slug: slugField,
  description: textField(0, 1200), selection: z.enum(["CURATED", "NEW", "FEATURED"]),
  position: z.int().min(0).max(9999), image: catalogImage.nullable(),
});

export async function saveCatalogCollection(actorId: string, raw: unknown) {
  const { id, expectedRevision, image, ...fields } = catalogWriteInput(collectionSaveInput, raw);
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockTaxonomy(tx);
    const current = await tx.collection.findUnique({ where: { id }, select: {
      revision: true, selection: true, _count: { select: { products: true } },
    } });
    if ((current?.revision ?? null) !== expectedRevision) throw new CatalogWriteError("conflict", "The collection changed. Reload it and try again.");
    if (await tx.collection.findFirst({ where: { slug: fields.slug, id: { not: id } }, select: { id: true } })) {
      throw new CatalogWriteError("conflict", "That collection URL is already in use.");
    }
    if (current?.selection === "CURATED" && fields.selection !== "CURATED" && current._count.products) {
      throw new OperationError("Remove the manual assignments before changing the collection rule.");
    }
    if (image && await missingImage(tx, [image.src])) throw new OperationError("The image path does not exist.");
    const data = { ...fields, imageSrc: image?.src ?? null, imageAlt: image?.alt ?? null };
    const result = current
      ? await tx.collection.update({ where: { id }, data: { ...data, revision: { increment: 1 } } })
      : await tx.collection.create({ data: { ...data, id, defaultPublished: false } });
    await tx.auditEvent.create({ data: { actorId, action: "TAXONOMY_SAVED", target: id,
      changes: { kind: "collection-metadata", created: !current, ...data, revision: result.revision },
    } });
    return result;
  });
}

const collectionPublicationInput = z.strictObject({
  collectionId: productIdField, marketId: marketIdInput, expectedRevision: revision, published: z.boolean(),
});

export async function saveCollectionMarketPublication(actorId: string, raw: unknown) {
  const { collectionId, marketId, expectedRevision, published } = catalogWriteInput(collectionPublicationInput, raw);
  return getDb().$transaction(async tx => {
    await authorizeTaxonomyMarket(tx, actorId, marketId);
    await lockTaxonomy(tx);
    const collection = await tx.collection.findUnique({ where: { id: collectionId }, select: {
      id: true, selection: true, revision: true, defaultPublished: true,
      marketPublications: { where: { marketId }, select: { published: true } },
    } });
    if (!collection) throw new CatalogWriteError("not_found", "The collection does not exist.");
    if (collection.revision !== expectedRevision) throw new CatalogWriteError("conflict", "The collection changed. Reload it and try again.");
    if (published && !await tx.product.findFirst({ where: {
      ...connectedCollectionProductFilter(collection), variants: { some: catalogVariantWhere(marketId) },
    }, select: { id: true } })) {
      throw new OperationError("Publish at least one matching product with a visible offer in this market before publishing the collection.");
    }
    const where = { collectionId_marketId: { collectionId, marketId } };
    await tx.collectionMarketPublication.upsert({ where, update: { published }, create: { collectionId, marketId, published } });
    const { revision: savedRevision } = await tx.collection.update({ where: { id: collectionId }, data: { revision: { increment: 1 } } });
    await tx.auditEvent.create({ data: { actorId, action: "TAXONOMY_SAVED", target: collectionId,
      changes: { kind: "collection-market-publication", marketId, published,
        previous: collection.marketPublications[0]?.published ?? collection.defaultPublished, revision: savedRevision },
    } });
    return { collectionId, marketId, published, revision: savedRevision };
  });
}

const productIdsInput = z.array(productIdField).max(1000).refine(ids => new Set(ids).size === ids.length, "List each product once.");
const collectionMembershipInput = z.strictObject({
  collectionId: productIdField, expectedProductIds: productIdsInput, productIds: productIdsInput, expectedRevision: revision.optional(),
});

export async function setCuratedCollectionProducts(actorId: string, raw: unknown) {
  const { collectionId, expectedProductIds, productIds, expectedRevision } = catalogWriteInput(collectionMembershipInput, raw);
  const expected = new Set(expectedProductIds);
  const desired = new Set(productIds);
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockTaxonomy(tx);
    const collection = await tx.collection.findUnique({
      where: { id: collectionId }, select: { revision: true, selection: true,
        products: { select: { productId: true }, orderBy: orderedCollectionProducts },
      },
    });
    if (!collection) throw new CatalogWriteError("not_found", "The collection does not exist.");
    if (collection.selection !== "CURATED") throw new OperationError("Only curated collections accept manual product membership.");

    const currentIds = collection.products.map(({ productId }) => productId);
    const current = new Set(currentIds);
    if ((expectedRevision !== undefined && collection.revision !== expectedRevision) ||
      current.size !== expected.size || currentIds.some(id => !expected.has(id))) {
      throw new CatalogWriteError("conflict", "The collection changed. Reload it and try again.");
    }
    const added = productIds.filter(id => !current.has(id));
    const removed = currentIds.filter(id => !desired.has(id));
    if (added.length && await tx.product.count({ where: { id: { in: added } } }) !== added.length) {
      throw new OperationError("A collection product does not exist.");
    }
    if (currentIds.length === productIds.length && currentIds.every((id, index) => id === productIds[index])) {
      return { collectionId, productIds, revision: collection.revision };
    }
    await tx.collectionProduct.deleteMany({ where: { collectionId } });
    if (productIds.length) await tx.collectionProduct.createMany({ data: productIds.map((productId, position) => ({
      collectionId, productId, position,
    })) });
    if (added.length || removed.length) {
      // Existing product editors send their last collection assignments with the product revision.
      await tx.product.updateMany({ where: { id: { in: [...added, ...removed] } }, data: { revision: { increment: 1 } } });
    }
    const { revision: savedRevision } = await tx.collection.update({ where: { id: collectionId }, data: { revision: { increment: 1 } } });
    await tx.auditEvent.create({ data: { actorId, action: "TAXONOMY_SAVED", target: collectionId,
      changes: { kind: "collection-membership", added, removed, order: productIds, revision: savedRevision },
    } });
    return { collectionId, productIds, revision: savedRevision };
  });
}
