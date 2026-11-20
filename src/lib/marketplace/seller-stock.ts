import type { MarketId } from "../../config/markets.ts";
import type { DbReader } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";
import { firstPartyStoreMode, marketplaceMode } from "../release-config.ts";
import { resolveSellerAccess } from "./seller-access.ts";

export const sellerStockStatuses = ["available", "low", "reserved", "unrouted"] as const;
export type SellerStockStatus = typeof sellerStockStatuses[number];
export type SellerStockFilters = { q: string; locationId: string; status?: SellerStockStatus };
const resultLimit = 2000;

export function sellerStockFilters(query: (name: string) => string | undefined): SellerStockFilters {
  const status = sellerStockStatuses.find(value => value === query("status"));
  return { q: query("q")?.trim().slice(0, 100) ?? "", locationId: query("location")?.trim().slice(0, 96) ?? "", status };
}

export async function sellerStockAccess(db: DbReader, shopperId: string, marketId: MarketId) {
  if (!marketplaceMode() || firstPartyStoreMode()) throw new CatalogWriteError("not_found", "Seller inventory is unavailable.");
  const access = await resolveSellerAccess(shopperId, marketId, "LISTINGS", undefined, db);
  if (!access) {
    throw new CatalogWriteError("forbidden", "Your shop needs an approved grant for this market.");
  }
  const shop = access.shop;
  const granted = access.owner ? (await db.marketplaceShopMarket.findMany({ where: { shopId: shop.id, status: "APPROVED" },
    select: { marketId: true } })).map(row => row.marketId) : [marketId];
  const location = {
    shopId: shop.id, marketId: { in: granted },
    OR: [{ marketId }, { marketServices: { some: { marketId, active: true } } }],
    marketServices: { none: { active: true, marketId: { notIn: granted } } },
  } satisfies Prisma.DispatchLocationWhereInput;
  return { shop, location, owner: access.owner };
}

export async function readSellerStock(shopperId: string, marketId: MarketId, filters: SellerStockFilters) {
  return getDb().$transaction(async db => {
    const { shop, location, owner } = await sellerStockAccess(db, shopperId, marketId);
    const locations = await db.dispatchLocation.findMany({ where: location,
      select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    if (filters.locationId && !locations.some(row => row.id === filters.locationId)) {
      throw new CatalogWriteError("forbidden", "The warehouse is outside your inventory scope.");
    }
    const search = { contains: filters.q, mode: "insensitive" as const };
    const pools = await db.inventoryPool.findMany({ where: {
      ownerId: shop.id, location, ...(filters.locationId && { locationId: filters.locationId }),
      ...(filters.q && { variant: { OR: [{ sku: search }, { product: { name: search } }] } }),
    }, orderBy: [{ variant: { sku: "asc" } }, { locationId: "asc" }, { id: "asc" }], take: resultLimit + 1,
    select: { id: true, ownerId: true, onHand: true, reserved: true, lowStockThreshold: true, updatedAt: true,
      variant: { select: { id: true, sku: true, label: true, active: true, archivedAt: true, product: { select: { id: true, name: true } } } },
      location: { select: { id: true, name: true, active: true, marketServices: { where: { active: true }, select: { marketId: true } } } } },
    });
    if (pools.length > resultLimit) throw new CatalogWriteError("invalid_input", "Narrow the inventory search to a warehouse or SKU.");
    const rows = pools.map(({ variant, location: site, ...pool }) => {
      const markets = site.marketServices.map(route => route.marketId);
      const routeEnabled = site.active && markets.includes(marketId) && variant.active && !variant.archivedAt;
      const available = pool.onHand - pool.reserved;
      const low = pool.lowStockThreshold !== null && available <= pool.lowStockThreshold;
      return { ...pool, updatedAt: pool.updatedAt.toISOString(), productId: variant.product.id, productName: variant.product.name,
        variantId: variant.id, sku: variant.sku, variantLabel: variant.label, locationId: site.id, locationName: site.name,
        markets, routeEnabled, available, unavailable: routeEnabled ? pool.reserved : pool.onHand, low };
    }).filter(row => !filters.status || (filters.status === "available" ? row.routeEnabled && row.available > 0 :
      filters.status === "low" ? row.low : filters.status === "reserved" ? row.reserved > 0 : !row.routeEnabled));
    return { shop, locations, rows, owner };
  }, { isolationLevel: "RepeatableRead" });
}
