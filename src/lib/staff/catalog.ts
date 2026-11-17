import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "../../generated/prisma/client.ts";
import { isRetailMarketId, markets } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import type { Specification } from "../catalog/types.ts";
import { mergeCatalogIdentifiers, productIdField, productInput, validationMessage, type ProductInput, type VariantInput } from "./catalog-input.ts";
import { missingImage } from "./catalog-media.ts";
import { hybridStoreMode, productionMode } from "../release-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { authorize, lockProductEdits, OperationError } from "./operations.ts";
import { merchandisingEnabled } from "./merchandising-config.ts";

const relations = {
  images: { select: { src: true, alt: true }, orderBy: { position: "asc" } },
  collections: { select: { collectionId: true }, orderBy: { collectionId: "asc" } },
  variants: { include: { offers: { orderBy: { marketId: "asc" } } }, orderBy: [{ position: "asc" }, { id: "asc" }] },
} as const satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof relations }>;

export async function catalogChoices(actorId: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  const [departments, collections] = await Promise.all([
    db.department.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }),
    db.collection.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }),
  ]);
  return { departments, collections };
}

export async function ownerProducts(actorId: string, search: string, page: number) {
  const db = getDb();
  await authorize(db, actorId, true);
  const take = 31;
  const rows = await db.product.findMany({
    where: search ? { OR: [
      { name: { contains: search, mode: "insensitive" } },
      { id: { contains: search, mode: "insensitive" } },
      { variants: { some: { sku: { contains: search, mode: "insensitive" } } } },
    ] } : undefined,
    orderBy: [{ position: "asc" }, { id: "asc" }], skip: (page - 1) * (take - 1), take,
    select: { id: true, name: true, slug: true, publication: true, demo: true, department: { select: { name: true } }, _count: { select: { variants: true } } },
  });
  return { rows: rows.slice(0, take - 1), hasNext: rows.length === take };
}

function asInput(row: ProductRow): ProductInput {
  const { id, slug, name, departmentId, description, keywords, images, publication, demo, featured, newArrival } = row;
  return {
    id, slug, name, departmentId, description, keywords, images, publication, demo, featured, newArrival,
    ...(row.brand && { brand: row.brand }),
    ...(row.shortDescription && { shortDescription: row.shortDescription }),
    collectionIds: row.collections.map(({ collectionId }) => collectionId),
    specifications: row.specifications as Specification[],
    variants: row.variants.map(({ sku, options, active, gtin, mpn, identifiersNotAssigned, imageSrc, imageAlt, offers }) => ({
      sku, options: options as Record<string, string>, active,
      ...(gtin && { gtin }),
      ...(mpn && { mpn }),
      ...(identifiersNotAssigned && { identifiersNotAssigned }),
      ...(imageSrc && imageAlt ? { image: { src: imageSrc, alt: imageAlt } } : {}),
      offers: offers.flatMap(({ marketId, currency, amountMinor, eligible }) =>
        isRetailMarketId(marketId) && markets[marketId].currency === currency ? [{ marketId, currency, amountMinor, eligible }] : []),
    })),
  };
}

export async function catalogProduct(db: DbReader, id: string) {
  const row = await db.product.findUnique({ where: { id }, include: relations });
  return row ? { product: asInput(row), revision: row.revision } : null;
}

export async function ownerProduct(actorId: string, id: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  return catalogProduct(db, id);
}

function desiredVariant(input: VariantInput, prior?: VariantInput): VariantInput {
  const retained = prior?.offers.filter((offer) => !input.offers.some(({ marketId }) => marketId === offer.marketId)) ?? [];
  const offers = [...input.offers, ...retained.map((offer) => ({ ...offer, eligible: false }))];
  const { gtin, mpn, identifiersNotAssigned, ...fields } = input;
  return {
    ...fields, offers: offers.sort((a, b) => a.marketId.localeCompare(b.marketId)),
    ...(gtin && { gtin }),
    ...(mpn && { mpn }),
    ...(identifiersNotAssigned && { identifiersNotAssigned }),
  };
}

function desiredProduct(input: ProductInput, prior: ProductInput | null, source: "editor" | "csv"): ProductInput {
  const { brand, ...fields } = input;
  const product = { ...fields, collectionIds: [...input.collectionIds].sort(), ...(brand && { brand }) };
  const variants = input.variants.map((item) => desiredVariant(item, prior?.variants.find(({ sku }) => sku === item.sku)));
  const omitted = prior?.variants.filter(({ sku }) => !variants.some((variant) => variant.sku === sku)) ?? [];
  if (source === "editor" && omitted.length) throw new OperationError("Deactivate an existing SKU to retire it.");
  if (source === "csv" && prior) {
    // Keep positions and publication of existing SKUs that are outside this import.
    const updates = new Map(variants.map((variant) => [variant.sku, variant]));
    return {
      ...product,
      variants: [...prior.variants.map((variant) => updates.get(variant.sku) ?? variant), ...variants.filter(({ sku }) => !prior.variants.some((old) => old.sku === sku))],
    };
  }
  return { ...product, variants };
}

async function validateRelations(db: DbReader, product: ProductInput) {
  if (!await db.department.findUnique({ where: { id: product.departmentId }, select: { id: true } })) {
    throw new OperationError("The category does not exist.");
  }
  if (await db.collection.count({ where: { id: { in: product.collectionIds } } }) !== product.collectionIds.length) {
    throw new OperationError("A selected collection does not exist.");
  }
  const slugConflict = await db.product.findFirst({ where: { slug: product.slug, id: { not: product.id } }, select: { id: true } });
  if (slugConflict) throw new OperationError(`The product URL "${product.slug}" belongs to ${slugConflict.id}.`);
  const collision = await db.variant.findFirst({
    where: { sku: { in: product.variants.map(({ sku }) => sku), mode: "insensitive" }, productId: { not: product.id } },
    select: { sku: true, productId: true },
  });
  if (collision) throw new OperationError(`SKU ${collision.sku} already belongs to ${collision.productId}.`);
  const paths = [...product.images, ...product.variants.flatMap(({ image }) => image ? [image] : [])].map(({ src }) => src);
  if (await missingImage(db, paths)) throw new OperationError("An image path does not exist. Upload the image or select a bundled catalog image.");
}

async function prepareProduct(db: DbReader, raw: unknown, source: "editor" | "csv", row: ProductRow | null) {
  // Validate the merged product as well as the submitted fields. An import can include only some existing SKUs.
  const supplied = productInput.safeParse(source === "csv" && row ? { ...(raw as object), publication: "DRAFT" } : raw);
  if (!supplied.success) throw new OperationError(validationMessage(supplied.error));
  const previous = row ? asInput(row) : null;
  const publication = (raw as ProductInput).publication;
  const desired = desiredProduct({ ...mergeCatalogIdentifiers(supplied.data, previous), publication }, previous, source);
  const result = productInput.safeParse(desired);
  if (!result.success) throw new OperationError(validationMessage(result.error));
  if (productionMode()) {
    if (result.data.demo) throw new OperationError("Use staging for sample products.");
    const images = [...result.data.images, ...result.data.variants.flatMap(({ image }) => image ? [image] : [])];
    if (result.data.publication === "ACTIVE" && images.some(({ src }) => !src.startsWith("/media/"))) {
      throw new OperationError("Upload approved product images before publishing in production.");
    }
  }
  await validateRelations(db, result.data);
  for (const variant of row?.variants ?? []) {
    const next = result.data.variants.find(({ sku }) => sku === variant.sku);
    for (const offer of variant.offers) {
      const price = next?.offers.find(({ marketId }) => marketId === offer.marketId);
      if (price && price.amountMinor <= (offer.discountMinor ?? 0)) {
        throw new OperationError(`SKU ${variant.sku} must cost more than its existing ${offer.currency} discount.`);
      }
    }
  }
  const status = !previous ? "New" : isDeepStrictEqual(previous, result.data) ? "Unchanged" : "Update";
  return { product: result.data, status, revision: row?.revision ?? null } as const;
}

export async function previewProduct(actorId: string, input: ProductInput) {
  const db = getDb();
  await authorize(db, actorId, true);
  const row = await db.product.findUnique({ where: { id: input.id }, include: relations });
  return prepareProduct(db, input, "csv", row);
}

export async function saveProduct(
  actorId: string, raw: unknown, expectedRevision: number | null, source: "editor" | "csv" | "merchandising",
  transaction?: Prisma.TransactionClient,
) {
  if (source === "merchandising" && (!transaction || !merchandisingEnabled())) throw new OperationError("Merchandising is unavailable.");
  const identity = productIdField.safeParse(raw && typeof raw === "object" ? (raw as ProductInput).id : null);
  if (!identity.success) throw new OperationError("Enter a valid stable product identifier.");
  const id = identity.data;
  try {
    const write = async (tx: Prisma.TransactionClient) => {
      await authorize(tx, actorId, true);
      await lockProductEdits(tx, id);
      const row = await tx.product.findUnique({ where: { id }, include: relations });
      if (source !== "merchandising" && row?.publication === "DRAFT" && merchandisingEnabled() && await tx.merchandisingCandidate.findFirst({
        where: { productId: id, ownsDraft: true, catalogRevision: { not: null }, publishedAt: null }, select: { id: true },
      })) {
        throw new OperationError("Open Merchandising to edit or publish this reviewed catalog draft.");
      }
      if ((row?.revision ?? null) !== expectedRevision) throw new OperationError("This product changed. Reload the editor or preview the import again.");
      const withSummary = source === "csv" && row?.shortDescription ? { ...(raw as ProductInput), shortDescription: row.shortDescription } : raw;
      const { product, status } = await prepareProduct(tx, withSummary, source === "csv" ? "csv" : "editor", row);
      if (status === "Unchanged") return status;

      // Checkout locks offers before variants and products. Catalog updates follow that order.
      await tx.$queryRaw`
        SELECT m."variantId" FROM "MarketOffer" m JOIN "Variant" v ON v."id" = m."variantId"
        WHERE v."productId" = ${id} ORDER BY m."variantId" COLLATE "C", m."marketId" FOR UPDATE OF m
      `;
      await tx.$queryRaw`SELECT "id" FROM "Variant" WHERE "productId" = ${id} ORDER BY "id" FOR NO KEY UPDATE`;
      const { variants, images, collectionIds, publication, ...fields } = product;
      if (hybridStoreMode() && publication === "ACTIVE" && row?.marketplaceShopId && row.marketplaceShopId !== storeShop.id) {
        await tx.$queryRaw`SELECT id FROM "MarketplaceShop" WHERE id = ${row.marketplaceShopId}::uuid FOR SHARE`;
        const seller = await tx.marketplaceShop.findUnique({ where: { id: row.marketplaceShopId }, select: {
          published: true, marketGrants: { where: { status: "APPROVED" }, select: { marketId: true } },
        } });
        if (!seller?.published) throw new OperationError("Approve the seller shop before publishing its listing.");
        const approved = new Set(seller.marketGrants.map(grant => grant.marketId));
        if (variants.some(variant => variant.active && variant.offers.some(offer => offer.eligible && !approved.has(offer.marketId)))) {
          throw new OperationError("Approve this seller for each market enabled on the listing before publishing.");
        }
      }
      const data = { ...fields, brand: fields.brand ?? null, shortDescription: fields.shortDescription || null, publication, active: publication === "ACTIVE" };
      const updated = await tx.product.upsert({
        where: { id }, create: { ...data, addedOn: new Date(), position: 10000 },
        update: { ...data, revision: { increment: 1 } },
      });
      await tx.productImage.deleteMany({ where: { productId: id } });
      await tx.productImage.createMany({ data: images.map((image, position) => ({ ...image, productId: id, position })) });
      await tx.collectionProduct.deleteMany({ where: { productId: id } });
      await tx.collectionProduct.createMany({ data: collectionIds.map((collectionId) => ({ collectionId, productId: id })) });

      for (const [position, variant] of variants.entries()) {
        const current = row?.variants.find(({ sku }) => sku === variant.sku);
        const variantId = current?.id ?? `v-${randomUUID()}`;
        const variantData = {
          options: variant.options, label: Object.values(variant.options).join(" / ") || "Standard", active: variant.active, position,
          gtin: variant.gtin ?? null, mpn: variant.mpn ?? null, identifiersNotAssigned: variant.identifiersNotAssigned ?? false,
          imageSrc: variant.image?.src ?? null, imageAlt: variant.image?.alt ?? null,
        };
        await tx.variant.upsert({
          where: { id: variantId }, update: variantData,
          create: { ...variantData, id: variantId, sku: variant.sku, productId: id, inventory: { create: { available: 0 } } },
        });
        for (const price of variant.offers) {
          await tx.marketOffer.upsert({
            where: { variantId_marketId: { variantId, marketId: price.marketId } },
            create: { ...price, variantId }, update: { amountMinor: price.amountMinor, eligible: price.eligible },
          });
          const old = current?.offers.find(({ marketId }) => marketId === price.marketId);
          if (old?.amountMinor !== price.amountMinor || old?.eligible !== price.eligible) {
            await tx.auditEvent.create({ data: {
              actorId, action: "PRICE_CHANGED", target: variantId,
              changes: { marketId: price.marketId, currency: price.currency, before: old?.amountMinor ?? null, after: price.amountMinor, eligible: price.eligible },
            } });
          }
        }
      }
      await tx.auditEvent.create({ data: {
        actorId, action: "PRODUCT_SAVED", target: id,
        changes: { source, status, publication, revision: updated.revision, skus: variants.map(({ sku }) => sku) },
      } });
      return status;
    };
    return transaction ? await write(transaction) : await getDb().$transaction(write, { timeout: 15_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new OperationError("The product URL or a SKU is already assigned. Review the conflicting values.");
    }
    throw error;
  }
}
