import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { firstPartyStoreMode, marketplaceMode, productionMode } from "../release-config.ts";
import { storeShop } from "./constants.ts";

export type MarketGrantStatus = "PENDING" | "APPROVED" | "DENIED";

export const marketVisibilitySelect = {
  published: true,
  marketGrants: { select: { marketId: true, status: true } },
} as const;

type ShopVisibility = {
  published: boolean;
  marketGrants?: readonly { marketId: MarketId; status: MarketGrantStatus }[];
};

type MerchantProduct = {
  demo: boolean;
  marketplaceShopId: string | null;
  marketplaceShop: ShopVisibility | null;
};

export function sellerVisibility(marketId: MarketId): Prisma.MarketplaceShopWhereInput {
  return { published: true, OR: [
    { id: storeShop.id },
    { marketGrants: { some: { marketId, status: "APPROVED" } } },
  ] };
}

export function merchantProductEligibility(marketId: MarketId): Prisma.ProductWhereInput {
  if (marketplaceMode() && !firstPartyStoreMode()) {
    return { OR: [{ marketplaceShopId: null }, { marketplaceShop: sellerVisibility(marketId) }] };
  }
  return {
    ...((firstPartyStoreMode() || productionMode()) && { demo: false }),
    OR: [{ marketplaceShopId: null }, { marketplaceShopId: storeShop.id }],
  };
}

export function merchantProductEligible(product: MerchantProduct, marketId: MarketId): boolean {
  if (marketplaceMode() && !firstPartyStoreMode()) {
    if (!product.marketplaceShopId) return true;
    const shop = product.marketplaceShop;
    return Boolean(shop?.published && (product.marketplaceShopId === storeShop.id ||
      shop.marketGrants?.some(grant => grant.marketId === marketId && grant.status === "APPROVED")));
  }
  if ((firstPartyStoreMode() || productionMode()) && product.demo) return false;
  return !product.marketplaceShopId || product.marketplaceShopId === storeShop.id;
}
