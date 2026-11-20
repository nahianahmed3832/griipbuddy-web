import { defaultMarketId, type MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { storeShop } from "./constants.ts";
import { getSellerAccess, resolveSellerAccess, lockSellerScope } from "./seller-access.ts";

type Db = Prisma.TransactionClient;
type BuyerSupportViewer = { shopperId?: string; staffOwner?: boolean; marketId?: MarketId };
const messageShop = { id: true, slug: true, name: true } as const;

const orderProof = {
  select: { id: true, shopperId: true, marketId: true, reference: true,
    items: { distinct: "marketplaceShopId", select: { marketplaceShopId: true } } },
} as const;

export async function buyerSupportAccess(db: Db, id: string, viewer: BuyerSupportViewer, forWrite = false) {
  const thread = await db.shopperRequest.findUnique({ where: { id }, select: {
    id: true, shopperId: true, shopId: true, marketId: true, orderId: true, order: orderProof,
  } });
  if (!thread) return null;
  const marketId = thread.marketId ?? thread.order?.marketId;
  const exactMarket = viewer.marketId === (marketId ?? defaultMarketId);
  if (viewer.shopperId === thread.shopperId) {
    // Owned order conversations remain available in the shopper's shared purchase history.
    const allowed = thread.orderId ? thread.order?.shopperId === viewer.shopperId && thread.order.marketId === marketId : exactMarket;
    return allowed ? { thread, side: "buyer" as const } : null;
  }
  if (thread.shopId === storeShop.id) {
    return viewer.staffOwner && exactMarket ? { thread, side: "staff" as const } : null;
  }
  if (!marketId || viewer.marketId !== marketId || !viewer.shopperId) return null;

  // Legacy requests are seller-visible only when immutable order ownership resolves the exact market and shop.
  if (thread.orderId && (thread.order?.shopperId !== thread.shopperId || thread.order.marketId !== marketId ||
    !thread.order.items.some(item => item.marketplaceShopId === thread.shopId))) return null;
  if (forWrite) await lockSellerScope(db, thread.shopId, marketId);
  return await getSellerAccess(viewer.shopperId, thread.shopId, marketId, "SUPPORT", db) ?
    { thread, side: "seller" as const } : null;
}

export async function sellerBuyerThreads(shopperId: string, marketId: MarketId, shopId?: string) {
  const access = await resolveSellerAccess(shopperId, marketId, "SUPPORT", shopId);
  if (!access) return null;
  const rows = await getDb().shopperRequest.findMany({
    where: { shopId: access.shop.id, OR: [
      { marketId, orderId: null }, { marketId, order: { marketId, items: { some: { marketplaceShopId: access.shop.id } } } },
      { marketId: null, order: { marketId, items: { some: { marketplaceShopId: access.shop.id } } } },
    ] },
    take: 60, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: {
      id: true, subject: true, closed: true, shopperId: true, updatedAt: true, shop: { select: messageShop },
      order: { select: { shopperId: true, reference: true } },
    },
  });
  return { shop: access.shop, rows: rows.filter(row => !row.order || row.order.shopperId === row.shopperId)
    .map(({ order, ...row }) => ({ id: row.id, subject: row.subject, closed: row.closed, updatedAt: row.updatedAt,
      shop: row.shop, order: order ? { reference: order.reference } : null })) };
}

export async function buyerSupportThread(id: string, viewer: BuyerSupportViewer) {
  const db = getDb();
  return db.$transaction(async tx => {
    const scope = await buyerSupportAccess(tx, id, viewer);
    if (!scope) return null;
    const row = await tx.shopperRequest.findUnique({ where: { id }, select: {
      id: true, subject: true, closed: true, shop: { select: messageShop }, order: { select: { reference: true } },
      product: { select: { name: true } },
      messages: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 80, select: { id: true, fromShop: true, text: true, createdAt: true } },
    } });
    return row && { ...row, viewerSide: scope.side };
  }, { isolationLevel: "RepeatableRead" });
}
