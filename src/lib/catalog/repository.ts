import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { activeDiscount } from "./offer-price.ts";
import { departmentAncestorPath, departmentFamily, stockedDepartments } from "./departments.ts";
import { searchProducts } from "./search.ts";
import { marketplaceMode } from "../release-config.ts";
import { isMarketSelectable, marketConfiguration } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { merchantProductEligibility } from "../marketplace/market-grants.ts";
import { integratedCheckout, recoveredStock } from "../commerce/integrated-checkout.ts";
import { dispatchStockRelations, marketStock } from "../commerce/location-inventory.ts";
import { connectedOfferScope } from "../commerce/market-offers.ts";
import { heroPhoto } from "./imagery.ts";
import { connectedCollectionProductFilter, orderedCollectionProducts, publicCollectionScope } from "./collection-selection.ts";
import { listCategoryPresentation } from "./category-presentation.ts";
import type { CatalogImage, CatalogProduct, CatalogRepository, Collection, Department, ListedVariant, Specification } from "./types.ts";

function departmentView(row: {
  id: string; slug: string; name: string; shortName: string; description: string; imageSrc: string; imageAlt: string; parentId: string | null;
  seoTitle?: string | null; seoDescription?: string | null;
}): Department {
  return {
    id: row.id, slug: row.slug, name: row.name, shortName: row.shortName, parentId: row.parentId ?? undefined,
    description: row.description, seoTitle: row.seoTitle ?? undefined, seoDescription: row.seoDescription ?? undefined,
    image: { src: row.imageSrc, alt: row.imageAlt },
  };
}

function collectionView(row: {
  id: string; slug: string; name: string; description: string; imageSrc: string | null; imageAlt: string | null;
  selection: "CURATED" | "NEW" | "FEATURED";
}): Collection {
  return {
    id: row.id, slug: row.slug, name: row.name, description: row.description,
    image: row.imageSrc && row.imageAlt ? { src: row.imageSrc, alt: row.imageAlt } : undefined,
    selection: row.selection === "NEW" ? "new" : row.selection === "FEATURED" ? "featured" : undefined,
  };
}

export function eligibleOffer(marketId: MarketId) {
  return { marketId, eligible: true, currency: markets[marketId].currency, offerId: null } as const;
}

export function publicProductScope(marketId: MarketId): Prisma.ProductWhereInput {
  return { ...merchantProductEligibility(marketId), active: true, publication: "ACTIVE",
    variants: { some: { active: true, managedInventory: false, offers: { some: eligibleOffer(marketId) } } } };
}

export async function listCategoryProductIds(categoryId: string, marketId: MarketId) {
  if (!isMarketSelectable(marketId)) return [];
  return getDb().$transaction(async tx => {
    const nodes = await tx.department.findMany({ where: { state: "ACTIVE" }, select: { id: true, parentId: true } });
    if (!departmentAncestorPath(new Map(nodes.map(node => [node.id, node])), categoryId)) return [];
    const descendants = [...departmentFamily(nodes, categoryId)];
    const rows = await tx.product.findMany({
      where: { AND: [publicProductScope(marketId), { OR: [
        { departmentId: { in: descendants } },
        { secondaryCategories: { some: { departmentId: { in: descendants } } } },
      ] }] },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    return rows.map(row => row.id);
  }, { isolationLevel: "RepeatableRead" });
}

const catalogMediaPath = /^\/media\/[a-f0-9]{64}$/;

export function marketImage(src: string, marketId: MarketId) {
  return catalogMediaPath.test(src) ? `${src}?market=${marketId}` : src;
}

export async function availableMarketMedia(sources: readonly string[], marketId: MarketId, reader?: DbReader) {
  const paths = [...new Set(sources.filter(src => catalogMediaPath.test(src)))];
  if (!paths.length) return new Set<string>();
  const db = reader ?? getDb();
  const connected = connectedOfferScope(marketId);
  const product = {
    OR: [publicProductScope(marketId), { variants: { some: { offers: { some: connected } } } }],
  } satisfies Prisma.ProductWhereInput;
  const variant = {
    OR: [
      { active: true, managedInventory: false, product: publicProductScope(marketId), offers: { some: eligibleOffer(marketId) } },
      { offers: { some: connected } },
    ],
  } satisfies Prisma.VariantWhereInput;
  const [gallery, variants, variantGallery] = await Promise.all([
    db.productImage.findMany({ where: { src: { in: paths }, product }, distinct: ["src"], select: { src: true } }),
    db.variant.findMany({ where: { imageSrc: { in: paths }, ...variant },
      distinct: ["imageSrc"], select: { imageSrc: true } }),
    db.variantImage.findMany({ where: { src: { in: paths }, variant },
      distinct: ["src"], select: { src: true },
    }),
  ]);
  return new Set([...gallery.map(row => row.src), ...variants.flatMap(row => row.imageSrc ?? []), ...variantGallery.map(row => row.src)]);
}

export async function availableMarketEditorialMedia(sources: readonly string[], marketId: MarketId, db: DbReader = getDb()) {
  const paths = [...new Set(sources.filter(src => catalogMediaPath.test(src)))];
  if (!paths.length) return new Set<string>();
  const [available, editorial] = await Promise.all([
    availableMarketMedia(paths, marketId, db),
    db.catalogMedia.findMany({ where: { id: { in: paths.map(src => src.slice(7)) }, editorial: true }, select: { id: true } }),
  ]);
  if (!editorial.length) return available;
  const approved = new Set(editorial.map(({ id }) => `/media/${id}`));
  const [categories, collections] = await Promise.all([
    listCategoryPresentation(marketId, marketConfiguration(marketId).defaultLocale, db),
    db.collection.findMany({ where: { ...publicCollectionScope(marketId), imageSrc: { in: [...approved] } },
      select: { imageSrc: true, imageAlt: true } }),
  ]);
  for (const { image, banner } of categories) {
    if (approved.has(image.src)) available.add(image.src);
    if (banner && approved.has(banner.src)) available.add(banner.src);
  }
  for (const { imageSrc, imageAlt } of collections) if (imageSrc && imageAlt) available.add(imageSrc);
  return available;
}

export function marketEditorialImage(image: CatalogImage, available: ReadonlySet<string>, marketId: MarketId) {
  if (!image.src.startsWith("/media/")) return image;
  return available.has(image.src) ? { ...image, src: marketImage(image.src, marketId) } : undefined;
}

function variantRelations(marketId: MarketId) {
  return { ...dispatchStockRelations, offers: { where: eligibleOffer(marketId) } } as const;
}

function productRelations(marketId: MarketId) {
  return {
    images: { orderBy: { position: "asc" } },
    variants: { where: { active: true, managedInventory: false, offers: { some: eligibleOffer(marketId) } },
      orderBy: { position: "asc" }, include: variantRelations(marketId) },
    marketplaceShop: { select: { id: true, slug: true, name: true } },
  } as const;
}

type VariantRow = Prisma.VariantGetPayload<{ include: ReturnType<typeof variantRelations> }>;
type ProductRow = Prisma.ProductGetPayload<{ include: ReturnType<typeof productRelations> }>;

function personalization(row: Pick<ProductRow, "personalizationPrompt" | "personalizationRequired">, marketId: MarketId) {
  if (!marketplaceMode() || integratedCheckout(marketId) || !row.personalizationPrompt) return undefined;
  return { prompt: row.personalizationPrompt, required: row.personalizationRequired };
}

function variantView(row: VariantRow, marketId: MarketId, shopId: string | null, now: Date): ListedVariant {
  const offer = row.offers[0];
  const discount = offer ? activeDiscount(offer, now) : 0;
  const discountEnd = discount > 0 ? offer?.discountEndsAt : null;
  return {
    id: row.id,
    sku: row.sku, gtin: row.gtin ?? undefined, mpn: row.mpn ?? undefined,
    identifiersNotAssigned: row.identifiersNotAssigned,
    options: row.options as Record<string, string>,
    image: row.imageSrc && row.imageAlt ? { src: marketImage(row.imageSrc, marketId), alt: row.imageAlt } : undefined,
    offer: offer?.currency === markets[marketId].currency ? {
      variantId: row.id, marketId, currency: offer.currency,
      amountMinor: offer.amountMinor - discount, regularMinor: offer.amountMinor, stock: marketStock(row, marketId, shopId),
      ...(discountEnd && { promotion: {
        endsAt: discountEnd.toISOString(),
        remainingSeconds: Math.ceil((discountEnd.getTime() - now.getTime()) / 1000),
      } }),
    } : null,
  };
}

function productView(row: ProductRow, marketId: MarketId, now: Date): CatalogProduct {
  return {
    id: row.id, slug: row.slug, name: row.name, departmentId: row.departmentId, description: row.description,
    brand: row.brand ?? undefined,
    shortDescription: row.shortDescription ?? undefined,
    specifications: row.specifications as Specification[], keywords: row.keywords,
    images: row.images.map(({ src, alt }) => ({ src: marketImage(src, marketId), alt })),
    variants: row.variants.map((variant) => variantView(variant, marketId, row.marketplaceShopId, now)),
    addedOn: row.addedOn.toISOString().slice(0, 10), newArrival: row.newArrival, featured: row.featured, demo: row.demo,
    ...(marketplaceMode() && { shop: row.marketplaceShop ?? storeShop }),
    personalization: personalization(row, marketId),
  };
}

async function resolvedStock(product: CatalogProduct, marketId: MarketId) {
  return { ...product, variants: await Promise.all(product.variants.map(variant => recoveredStock(variant, product.id, variant.id, marketId))) };
}

export const catalog: CatalogRepository = {
  async listDepartments(marketId) {
    if (marketId && !isMarketSelectable(marketId)) return [];
    const db = getDb();
    const [rows, occupied] = await Promise.all([
      db.department.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }),
      marketId ? db.product.groupBy({
        by: ["departmentId"],
        where: publicProductScope(marketId),
      }) : null,
    ]);
    const departments = rows.map(departmentView);
    if (!marketId || !occupied) return departments;
    const visible = stockedDepartments(departments, occupied.map(row => row.departmentId));
    const available = await availableMarketEditorialMedia(visible.map(row => row.image.src), marketId);
    return visible.map(row => ({ ...row, image: marketEditorialImage(row.image, available, marketId) ?? heroPhoto }));
  },
  async getDepartment(slug) {
    const row = await getDb().department.findUnique({ where: { slug } });
    return row ? departmentView(row) : null;
  },
  async listCollections(marketId) {
    if (marketId && !isMarketSelectable(marketId)) return [];
    const collections = (await getDb().collection.findMany({ where: publicCollectionScope(marketId),
      orderBy: [{ position: "asc" }, { id: "asc" }] })).map(collectionView);
    if (!marketId) return collections;
    const available = await availableMarketEditorialMedia(collections.flatMap(row => row.image?.src ?? []), marketId);
    return collections.map(row => ({ ...row, image: row.image && (marketEditorialImage(row.image, available, marketId) ?? heroPhoto) }));
  },
  async getCollection(slug, marketId) {
    if (marketId && !isMarketSelectable(marketId)) return null;
    const row = await getDb().collection.findFirst({ where: { slug, ...publicCollectionScope(marketId) } });
    return row ? collectionView(row) : null;
  },
  async listProducts({ marketId, at = new Date(), departmentId, departmentIds, collectionId, search, productIds, shopId }) {
    if (!isMarketSelectable(marketId)) return [];
    const db = getDb();
    const where: Prisma.ProductWhereInput = {
      departmentId: departmentIds ? { in: [...departmentIds] } : departmentId,
      AND: [publicProductScope(marketId), ...(shopId === storeShop.id ? [{ OR: [{ marketplaceShopId: null }, { marketplaceShopId: shopId }] }]
        : shopId ? [{ marketplaceShopId: shopId }] : [])],
      ...(productIds && { id: { in: [...productIds] } }),
    };
    let collectionOrder: ReadonlyMap<string, number> | undefined;
    if (collectionId) {
      const collection = await db.collection.findFirst({ where: { id: collectionId, ...publicCollectionScope(marketId) } });
      if (!collection) return [];
      Object.assign(where, connectedCollectionProductFilter(collection));
      if (collection.selection === "CURATED") {
        const members = await db.collectionProduct.findMany({ where: { collectionId }, orderBy: orderedCollectionProducts,
          select: { productId: true } });
        collectionOrder = new Map(members.map(({ productId }, position) => [productId, position]));
      }
    }
    const rows = await db.product.findMany({
      where, orderBy: { position: "asc" }, include: { ...productRelations(marketId), department: true },
    });
    if (collectionOrder) rows.sort((a, b) => (collectionOrder.get(a.id) ?? Infinity) - (collectionOrder.get(b.id) ?? Infinity));
    const listed = await Promise.all(rows.map((row) => resolvedStock(productView(row, marketId, at), marketId)));
    return search ? searchProducts(listed, new Map(rows.map((row) => [row.departmentId, row.department])), search) : listed;
  },
  async getProduct(slug, marketId) {
    if (!isMarketSelectable(marketId)) return null;
    const row = await getDb().product.findFirst({
      where: { ...publicProductScope(marketId), slug },
      include: productRelations(marketId),
    });
    return row ? resolvedStock(productView(row, marketId, new Date()), marketId) : null;
  },
  async resolveVariants(variantIds, marketId) {
    if (!isMarketSelectable(marketId)) return [];
    const rows = await getDb().variant.findMany({
      // Cart keeps unavailable lines locally while eligible offers are re-resolved
      // for the selected market. Use generic line labels for ineligible products.
      where: { id: { in: [...variantIds] }, active: true, managedInventory: false, offers: { some: eligibleOffer(marketId) },
        product: { ...merchantProductEligibility(marketId), active: true, publication: "ACTIVE" } },
      include: { ...variantRelations(marketId), product: { include: { images: { orderBy: { position: "asc" }, take: 1 },
        marketplaceShop: { select: { id: true, slug: true, name: true } } } } },
    });
    const now = new Date();
    return Promise.all(rows.map((row) => {
      const variant = variantView(row, marketId, row.product.marketplaceShopId, now);
      const { slug, name, images } = row.product;
      const image = variant.image ?? { src: marketImage(images[0]?.src ?? "/editorial/hero.webp", marketId), alt: images[0]?.alt ?? name };
      return recoveredStock({
        variantId: row.id, productId: row.productId, slug, name, variantLabel: row.label, sku: row.sku, image,
        ...(marketplaceMode() && { shop: row.product.marketplaceShop ?? storeShop }),
        personalization: personalization(row.product, marketId),
        offer: variant.offer,
      }, row.product.id, row.id, marketId);
    }));
  },
};
