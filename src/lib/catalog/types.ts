import type { Currency, MarketId } from "../../config/markets.ts";
import type { Personalization } from "./personalization.ts";

export type CatalogImage = { src: string; alt: string };
export type Specification = { label: string; value: string };

export type Department = {
  id: string;
  slug: string;
  name: string;
  shortName: string;
  parentId?: string;
  description: string;
  image: CatalogImage;
};

export type Collection = {
  id: string;
  slug: string;
  name: string;
  description: string;
  image?: CatalogImage;
  productIds?: readonly string[];
  selection?: "new" | "featured";
};

export type Variant = {
  id: string;
  options: Readonly<Record<string, string>>;
  image?: CatalogImage;
  videoUrl?: string;
};

export type MarketOffer = {
  variantId: string;
  marketId: MarketId;
  currency: Currency;
  amountMinor: number;
  regularMinor?: number;
  promotion?: { endsAt: string; remainingSeconds: number };
  stock: number;
};

export type Product = {
  id: string;
  slug: string;
  name: string;
  brand?: string;
  departmentId: string;
  description: string;
  specifications: readonly Specification[];
  shortDescription?: string;
  keywords: readonly string[];
  images: readonly CatalogImage[];
  videoUrl?: string;
  variants: readonly Variant[];
  addedOn: string;
  newArrival?: boolean;
  featured?: boolean;
  demo?: boolean;
  personalization?: Personalization;
  shop?: { id: string; slug: string; name: string };
};

export type ListedVariant = Variant & {
  sku?: string;
  gtin?: string;
  mpn?: string;
  identifiersNotAssigned?: boolean;
  offer: MarketOffer | null;
};
export type CatalogProduct = Omit<Product, "variants"> & { variants: readonly ListedVariant[] };

export type ProductQuery = {
  marketId: MarketId;
  departmentId?: string;
  departmentIds?: readonly string[];
  collectionId?: string;
  search?: string;
  limit?: number;
  leadImageOnly?: boolean;
  productIds?: readonly string[];
  shopId?: string;
};

export type CartCatalogItem = {
  productId?: string;
  variantId: string;
  slug: string;
  name: string;
  variantLabel: string;
  image: CatalogImage;
  offer: MarketOffer | null;
  personalization?: Personalization;
  shop?: { id: string; slug: string; name: string };
};

export interface CatalogRepository {
  listDepartments(marketId?: MarketId): Promise<readonly Department[]>;
  getDepartment(slug: string): Promise<Department | null>;
  listCollections(): Promise<readonly Collection[]>;
  getCollection(slug: string): Promise<Collection | null>;
  listProducts(query: ProductQuery): Promise<readonly CatalogProduct[]>;
  getProduct(slug: string, marketId: MarketId): Promise<CatalogProduct | null>;
  resolveVariants(variantIds: readonly string[], marketId: MarketId): Promise<readonly CartCatalogItem[]>;
}

export function variantLabel(variant: Variant): string {
  return Object.values(variant.options).join(" / ") || "Standard";
}
