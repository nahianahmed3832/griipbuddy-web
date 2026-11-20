import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { getDb } from "../db/client.ts";
import { storeShop } from "./constants.ts";

export const sellerPermissions = [
  "PROFILE", "LISTINGS", "ORDER_PREPARATION", "SUPPORT", "FINANCE_VIEW", "PAYOUT_REQUEST", "PAYOUT_DESTINATION",
] as const;
export type SellerPermission = (typeof sellerPermissions)[number];

const shopSelect = { id: true, name: true, slug: true, published: true } as const;
type Db = Prisma.TransactionClient;
type ShopIdentity = { id: string; name: string; slug: string; published: boolean };

export type SellerAccess = {
  shop: ShopIdentity; shopperId: string; marketId: MarketId; owner: boolean; permissions: SellerPermission[];
};

export function sellerMembership(shopperId: string, marketId: MarketId, permission?: SellerPermission): Prisma.MarketplaceSellerMemberWhereInput {
  return { shopperId, marketId, acceptedAt: { not: null }, revokedAt: null, ...(permission && { permissions: { has: permission } }) };
}

export function activeSellerMarket(marketId: MarketId): Prisma.MarketplaceShopWhereInput {
  return { id: { not: storeShop.id }, published: true, marketGrants: { some: { marketId, status: "APPROVED" } } };
}

async function scopedSellerAccess(shopperId: string, marketId: MarketId, condition: Prisma.MarketplaceShopWhereInput,
  permission: SellerPermission, db: Db): Promise<SellerAccess | null> {
  const membership = sellerMembership(shopperId, marketId);
  const matches = await db.marketplaceShop.findMany({
    where: { AND: [condition, activeSellerMarket(marketId), { OR: [{ ownerId: shopperId },
      { teamMembers: { some: { ...membership, permissions: { has: permission } } } }] }] },
    select: { ...shopSelect, ownerId: true, teamMembers: { where: membership, take: 1, select: { permissions: true } } },
    orderBy: { id: "asc" },
    take: 2,
  });
  const row = matches.length === 1 ? matches[0] : matches.find(shop => shop.ownerId === shopperId);
  if (!row) return null;
  const { ownerId, teamMembers, ...shop } = row;
  const owner = ownerId === shopperId;
  const permissions = owner ? [...sellerPermissions] : teamMembers[0]?.permissions ?? [];
  return permissions.includes(permission) ? { shop, shopperId, marketId, owner, permissions } : null;
}

export async function getSellerAccess(shopperId: string, shopId: string, marketId: MarketId, permission: SellerPermission,
  db: Db = getDb()): Promise<SellerAccess | null> {
  if (!uuid.safeParse(shopId).success) return null;
  return scopedSellerAccess(shopperId, marketId, { id: shopId }, permission, db);
}

export async function resolveSellerAccess(shopperId: string, marketId: MarketId, permission: SellerPermission,
  shopId?: string, db: Db = getDb()): Promise<SellerAccess | null> {
  if (shopId) return getSellerAccess(shopperId, shopId, marketId, permission, db);
  const owned = await scopedSellerAccess(shopperId, marketId, { ownerId: shopperId }, permission, db);
  return owned ?? scopedSellerAccess(shopperId, marketId, { ownerId: { not: shopperId } }, permission, db);
}

// Use within a writer transaction before checking access. Market approval and team writers take the same shop lock.
export async function lockSellerScope(db: Db, shopId: string, marketId: MarketId) {
  await db.$queryRaw`SELECT id FROM "MarketplaceShop" WHERE id = ${shopId}::uuid FOR SHARE`;
  await db.$queryRaw`SELECT "shopId" FROM "MarketplaceShopMarket"
    WHERE "shopId" = ${shopId}::uuid AND "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
}

export async function sellerNavigationShop(shopperId: string, marketId: MarketId, shopId?: string) {
  if (shopId && !uuid.safeParse(shopId).success) return null;
  const rows = await getDb().marketplaceShop.findMany({
    where: { AND: [activeSellerMarket(marketId), ...(shopId ? [{ id: shopId }] : []),
      { teamMembers: { some: sellerMembership(shopperId, marketId) } }] },
    select: { ...shopSelect, marketGrants: true,
      teamMembers: { where: sellerMembership(shopperId, marketId), take: 1, select: { permissions: true } } },
    orderBy: { name: "asc" },
    take: 2,
  });
  return rows.length === 1 ? { ...rows[0], permissions: rows[0].teamMembers[0]?.permissions ?? [] } : null;
}
