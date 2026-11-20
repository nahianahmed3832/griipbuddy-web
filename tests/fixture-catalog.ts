import type { MarketId } from "../src/config/markets.ts";
import { searchProducts } from "../src/lib/catalog/search.ts";
import { collections, departments, offers, products } from "../prisma/demo-data.ts";
import { variantLabel, type CatalogProduct, type CatalogRepository, type Collection, type Department, type Product } from "../src/lib/catalog/types.ts";

const offersByKey = new Map(offers.map((offer) => [`${offer.marketId}:${offer.variantId}`, offer]));
const departmentById = new Map<string, Department>(departments.map((department) => [department.id, department]));
const collectionById = new Map<string, Collection>(collections.map((collection) => [collection.id, collection]));
const variantsById = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, { product, variant }] as const)));

function withMarketOffers(product: Product, marketId: MarketId): CatalogProduct {
  return {
    ...product,
    variants: product.variants.map((variant) => ({ ...variant, offer: offersByKey.get(`${marketId}:${variant.id}`) ?? null })),
  };
}

function belongsTo(product: Product, collection: Collection): boolean {
  if (collection.selection === "new") return Boolean(product.newArrival);
  if (collection.selection === "featured") return Boolean(product.featured);
  return collection.productIds?.includes(product.id) ?? false;
}

export const demoCatalogRepository: CatalogRepository = {
  async listDepartments() { return departments; },
  async getDepartment(slug) { return departments.find((department) => department.slug === slug) ?? null; },
  async listCollections() { return collections; },
  async getCollection(slug) { return collections.find((collection) => collection.slug === slug) ?? null; },
  async listProducts({ marketId, departmentId, collectionId, search }) {
    const collection = collectionId ? collectionById.get(collectionId) : undefined;
    if (collectionId && !collection) return [];
    const listed = products
      .filter((product) => (!departmentId || product.departmentId === departmentId) && (!collection || belongsTo(product, collection)))
      .map((product) => withMarketOffers(product, marketId))
      .filter((product) => product.variants.some((variant) => variant.offer !== null));
    return search ? searchProducts(listed, departmentById, search) : listed;
  },
  async getProduct(slug, marketId) {
    const product = products.find((item) => item.slug === slug);
    return product ? withMarketOffers(product, marketId) : null;
  },
  async resolveVariants(variantIds, marketId) {
    return variantIds.flatMap((variantId) => {
      const match = variantsById.get(variantId);
      if (!match) return [];
      const { product, variant } = match;
      return [{
        variantId, slug: product.slug, name: product.name, variantLabel: variantLabel(variant),
        image: variant.image ?? product.images[0], offer: offersByKey.get(`${marketId}:${variantId}`) ?? null,
      }];
    });
  },
};
