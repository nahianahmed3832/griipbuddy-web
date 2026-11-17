import { cache } from "react";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { devOfferPricing } from "../marketplace/dev-offer.ts";
import { activeDiscount } from "./offer-price.ts";
import { stockedDepartments } from "./departments.ts";
import { searchProducts } from "./search.ts";
import { productCards, type ProductCardData } from "./listing.ts";
import { hybridStoreMode, marketplaceMode, productionMode } from "../release-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { merchantProductEligibility } from "../marketplace/market-grants.ts";
import { integratedCheckout, recoveredStock } from "../commerce/integrated-checkout.ts";
import type { CatalogProduct, CatalogRepository, Collection, Department, ListedVariant, Specification } from "./types.ts";

function departmentView(row: {
  id: string; slug: string; name: string; shortName: string; description: string; imageSrc: string; imageAlt: string; parentId: string | null;
}): Department {
  return {
    id: row.id, slug: row.slug, name: row.name, shortName: row.shortName, parentId: row.parentId ?? undefined,
    description: row.description, image: { src: row.imageSrc, alt: row.imageAlt },
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

function variantRelations(marketId: MarketId) {
  return { inventory: true, offers: { where: { marketId, eligible: true } } } as const;
}

function productRelations(marketId: MarketId, leadImageOnly = false) {
  return {
    images: { orderBy: { position: "asc" }, ...(leadImageOnly && { take: 1 }) },
    variants: { where: { active: true }, orderBy: { position: "asc" }, include: variantRelations(marketId) },
    marketplaceShop: { select: { id: true, slug: true, name: true } },
  } as const;
}

type VariantRow = Prisma.VariantGetPayload<{ include: ReturnType<typeof variantRelations> }>;
type ProductRow = Prisma.ProductGetPayload<{ include: ReturnType<typeof productRelations> }>;
type DevPricing = Awaited<ReturnType<typeof devOfferPricing>>;

function personalization(row: Pick<ProductRow, "personalizationPrompt" | "personalizationRequired">) {
  if (!marketplaceMode() || integratedCheckout() || !row.personalizationPrompt) return undefined;
  return { prompt: row.personalizationPrompt, required: row.personalizationRequired };
}

function variantView(row: VariantRow, marketId: MarketId, now: Date, product: Pick<ProductRow, "marketplaceShopId">, campaign: DevPricing): ListedVariant {
  const offer = row.offers[0];
  const discount = offer ? activeDiscount(offer, now) : 0;
  const special = offer && campaign?.price({ ...row, product }, { amountMinor: offer.amountMinor - discount, regularMinor: offer.amountMinor });
  const amountMinor = special?.amountMinor ?? (offer ? offer.amountMinor - discount : 0);
  const regularMinor = special?.regularMinor ?? offer?.amountMinor ?? 0;
  const discountEnd = regularMinor > amountMinor ? (special ? campaign?.end : offer?.discountEndsAt) : null;
  return {
    id: row.id,
    sku: row.sku, gtin: row.gtin ?? undefined, mpn: row.mpn ?? undefined,
    identifiersNotAssigned: row.identifiersNotAssigned,
    options: row.options as Record<string, string>,
    image: row.imageSrc && row.imageAlt ? { src: row.imageSrc, alt: row.imageAlt } : undefined,
    offer: offer?.currency === markets[marketId].currency ? {
      variantId: row.id, marketId, currency: offer.currency,
      amountMinor, regularMinor, stock: row.inventory?.available ?? 0,
      ...(discountEnd && { promotion: {
        endsAt: discountEnd.toISOString(),
        remainingSeconds: Math.ceil((discountEnd.getTime() - now.getTime()) / 1000),
      } }),
    } : null,
  };
}

function productView(row: ProductRow, marketId: MarketId, now: Date, campaign: DevPricing): CatalogProduct {
  return {
    id: row.id, slug: row.slug, name: row.name, departmentId: row.departmentId, description: row.description,
    brand: row.brand ?? undefined,
    shortDescription: row.shortDescription ?? undefined,
    specifications: row.specifications as Specification[], keywords: row.keywords,
    images: row.images.map(({ src, alt }) => ({ src, alt })),
    variants: row.variants.map((variant) => variantView(variant, marketId, now, row, campaign)),
    addedOn: row.addedOn.toISOString().slice(0, 10), newArrival: row.newArrival, featured: row.featured, demo: row.demo,
    ...(marketplaceMode() && { shop: row.marketplaceShop ?? storeShop }),
    personalization: personalization(row),
  };
}

function catalogCampaign(marketId: MarketId, rows: readonly ProductRow[], now: Date) {
  const variants = rows.flatMap(product => product.variants.map(({ id, productId }) => ({ id, productId, product })));
  return devOfferPricing(marketId, variants, now).catch(() => null);
}

async function catalogProducts(rows: readonly ProductRow[], marketId: MarketId) {
  const now = new Date();
  const campaign = await catalogCampaign(marketId, rows, now);
  return rows.map(row => productView(row, marketId, now, campaign));
}

async function resolvedStock(product: CatalogProduct) {
  return { ...product, variants: await Promise.all(product.variants.map(variant => recoveredStock(variant, product.id, variant.id))) };
}

export const publicShop = merchantProductEligibility;

const departmentRows = cache(async () => getDb().department.findMany({ orderBy: [{ position: "asc" }, { name: "asc" }] }));

function productWhere(marketId: MarketId): Prisma.ProductWhereInput {
  return {
    publication: "ACTIVE",
    ...(productionMode() && { demo: false }),
    variants: { some: { active: true, offers: { some: { marketId, eligible: true, currency: markets[marketId].currency } } } },
  };
}

const productOrder: Prisma.ProductOrderByWithRelationInput[] = [{ position: "asc" }, { id: "asc" }];

async function listProductsForCards(where: Prisma.ProductWhereInput, marketId: MarketId, take?: number, cursor?: string) {
  const rows = await getDb().product.findMany({ where: { ...productWhere(marketId), ...where }, orderBy: productOrder,
    include: productRelations(marketId, true), take, ...(cursor && { cursor: { id: cursor }, skip: 1 }) });
  const products = await catalogProducts(rows, marketId);
  return products.length && integratedCheckout() ? Promise.all(products.map(resolvedStock)) : products;
}

export async function relatedProductCards(marketId: MarketId, departmentId: string, productId: string) {
  const cards: ProductCardData[] = [];
  const batchSize = 12;
  let cursor: string | undefined;
  do {
    // Some older listings have no usable image. Keep looking until enough cards can actually be displayed.
    const products = await listProductsForCards({ ...publicShop(marketId), departmentId, id: { not: productId } }, marketId, batchSize, cursor);
    cards.push(...productCards(products).slice(0, 4 - cards.length));
    cursor = products.length === batchSize && cards.length < 4 ? products.at(-1)?.id : undefined;
  } while (cursor);
  return cards;
}

export async function listAddOnCandidates(marketId: MarketId, product: Pick<CatalogProduct, "departmentId">, departmentIds: readonly string[], slugs: readonly string[]) {
  if (!departmentIds.length && !slugs.length) return [];
  return listProductsForCards({ departmentId: { not: product.departmentId }, AND: [publicShop(marketId), { OR: [
    ...(departmentIds.length ? [{ departmentId: { in: [...departmentIds] } }] : []),
    ...(slugs.length ? [{ slug: { in: [...slugs] } }] : []),
  ] }] }, marketId);
}

export const catalog: CatalogRepository = {
  listDepartments: cache(async (marketId?: MarketId) => {
    const db = getDb();
    const [rows, occupied] = await Promise.all([
      departmentRows(),
      marketId ? db.product.groupBy({
        by: ["departmentId"],
        where: { ...productWhere(marketId), ...publicShop(marketId) },
      }) : null,
    ]);
    const departments = rows.map(departmentView);
    return occupied ? stockedDepartments(departments, occupied.map(row => row.departmentId)) : departments;
  }),
  getDepartment: cache(async (slug: string) => {
    const row = await getDb().department.findUnique({ where: { slug } });
    return row ? departmentView(row) : null;
  }),
  async listCollections() {
    return (await getDb().collection.findMany({ orderBy: { position: "asc" } })).map(collectionView);
  },
  getCollection: cache(async (slug: string) => {
    const row = await getDb().collection.findUnique({ where: { slug } });
    return row ? collectionView(row) : null;
  }),
  async listProducts({ marketId, departmentId, departmentIds, collectionId, search, limit, productIds, shopId, leadImageOnly }) {
    const db = getDb();
    const where: Prisma.ProductWhereInput = {
      ...productWhere(marketId), departmentId: departmentIds ? { in: [...departmentIds] } : departmentId,
      AND: [publicShop(marketId), ...(shopId === storeShop.id ? [{ OR: [{ marketplaceShopId: null }, { marketplaceShopId: shopId }] }]
        : shopId ? [{ marketplaceShopId: shopId }] : [])],
      ...(productIds && { id: { in: [...productIds] } }),
    };
    if (collectionId) {
      const collection = await db.collection.findUnique({ where: { id: collectionId } });
      if (!collection) return [];
      if (collection.selection === "NEW") where.newArrival = true;
      else if (collection.selection === "FEATURED") where.featured = true;
      else where.collections = { some: { collectionId } };
    }
    const [rows, departments] = await Promise.all([
      db.product.findMany({ where, orderBy: productOrder, include: productRelations(marketId, leadImageOnly) }),
      search ? departmentRows() : [],
    ]);
    const listed = await catalogProducts(rows, marketId);
    const ranked = search ? searchProducts(listed, new Map(departments.map(row => [row.id, row])), search) : listed;
    // Resolve stock only after ranking and capping suggestions. Integrated inventory can require remote calls.
    const products = limit === undefined ? ranked : ranked.slice(0, limit);
    return products.length && integratedCheckout() ? Promise.all(products.map(resolvedStock)) : products;
  },
  async getProduct(slug, marketId) {
    const row = await getDb().product.findFirst({
      where: { ...publicShop(marketId), slug, publication: "ACTIVE", variants: { some: {
        active: true, ...(hybridStoreMode() && { offers: { some: { marketId, eligible: true, currency: markets[marketId].currency } } }),
      } } },
      include: productRelations(marketId),
    });
    if (!row) return null;
    const now = new Date();
    return resolvedStock(productView(row, marketId, now, await catalogCampaign(marketId, [row], now)));
  },
  async resolveVariants(variantIds, marketId) {
    const rows = await getDb().variant.findMany({
      where: { id: { in: [...variantIds] }, product: publicShop(marketId) },
      include: { ...variantRelations(marketId), product: { include: { images: { orderBy: { position: "asc" }, take: 1 },
        marketplaceShop: { select: { id: true, slug: true, name: true } } } } },
    });
    const now = new Date();
    const campaign = await devOfferPricing(marketId, rows, now).catch(() => null);
    return Promise.all(rows.filter((row) => row.product.publication !== "DRAFT").map((row) => {
      const variant = variantView(row, marketId, now, row.product, campaign);
      const { slug, name, images } = row.product;
      const image = variant.image ?? { src: images[0]?.src ?? "/editorial/hero.webp", alt: images[0]?.alt ?? name };
      return recoveredStock({
        variantId: row.id, productId: row.productId, slug, name, variantLabel: row.label, image,
        ...(marketplaceMode() && { shop: row.product.marketplaceShop ?? storeShop }),
        personalization: personalization(row.product),
        offer: row.active && row.product.publication === "ACTIVE" ? variant.offer : null,
      }, row.product.id, row.id);
    }));
  },
};
