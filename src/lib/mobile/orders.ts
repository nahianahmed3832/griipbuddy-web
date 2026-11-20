import type { MarketId } from "../../config/markets.ts";
import { markets } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { getSellerAccess } from "../marketplace/seller-access.ts";

export const mobileOrderPageSize = 20;
export type MobileOrdersInput = { marketId: MarketId; page: number } &
  ({ audience: "customer" } | { audience: "seller"; shopId: string });

export async function mobileOrders(shopperId: string, input: MobileOrdersInput) {
  const { marketId, page } = input;
  if (!isMarketSelectable(marketId) || !Number.isInteger(page) || page < 1 || page > 50) return null;
  const currency = markets[marketId].currency;
  return getDb().$transaction(async db => {
    const core = { marketId, currency };
    const pagination = { take: mobileOrderPageSize + 1, skip: (page - 1) * mobileOrderPageSize,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }] } as const;
    const sort = { ...pagination, orderBy: [...pagination.orderBy] };
    const header = { id: true, reference: true, createdAt: true, status: true } as const;
    let matching;
    if (input.audience === "customer") {
      matching = await db.order.findMany({
        ...sort, where: { ...core, shopperId }, select: { ...header, fulfillmentStatus: true, totalMinor: true,
          payment: { select: { status: true, method: true } } },
      });
    } else {
      if (!await getSellerAccess(shopperId, input.shopId, marketId, "ORDER_PREPARATION", db)) return null;
      const sellerItems = { marketplaceShopId: input.shopId, currency };
      matching = (await db.order.findMany({
        ...sort, where: { ...core, items: { some: sellerItems } },
        select: { ...header, sellerFulfillments: { where: { shopId: input.shopId }, select: { status: true } },
          _count: { select: { items: { where: sellerItems } } } },
      })).map(({ sellerFulfillments, _count, ...row }) => ({
        ...row, sellerPreparation: sellerFulfillments[0]?.status ?? null, ownLineCount: _count.items,
      }));
    }
    return { version: 1, marketId, currency, page,
      nextPage: matching.length > mobileOrderPageSize && page < 50 ? page + 1 : null,
      orders: matching.slice(0, mobileOrderPageSize),
    };
  }, { isolationLevel: "RepeatableRead" });
}
