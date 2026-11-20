import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { firstPartyStoreMode } from "../release-config.ts";
import { storeShop } from "./constants.ts";
import { sellerVisibility } from "./market-grants.ts";

export function couponDirectoryShops(marketId: MarketId) {
  return { OR: [{ shopId: null }, { shop: {
    ...sellerVisibility(marketId), ...(firstPartyStoreMode() && { id: storeShop.id }),
  } }] };
}

export async function listedCoupons(marketId: MarketId, now = new Date()) {
  return getDb().$transaction(async db => {
    const items = await db.marketplaceCoupon.findMany({
      where: {
        marketId, enabled: true, publishedInDirectory: true,
        AND: [
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          couponDirectoryShops(marketId),
        ],
      },
      select: { code: true, kind: true, value: true, minimumMinor: true, useLimit: true, endsAt: true,
        shop: { select: { slug: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { code: "asc" }],
      take: 100,
    });
    const limited = items.filter(coupon => coupon.useLimit !== null).map(coupon => coupon.code);
    if (!limited.length) return items;
    const [orders, holds] = await Promise.all([
      db.order.groupBy({ by: ["couponCode"], where: { marketId, couponCode: { in: limited } }, _count: true }),
      db.prepaidCheckout.groupBy({ by: ["couponCode"], where: {
        couponCode: { in: limited }, attempt: { marketId }, state: { in: ["PREPARING", "AWAITING_PAYMENT"] },
      }, _count: true }),
    ]);
    const placed = new Map(orders.map(row => [row.couponCode, row._count]));
    const pending = new Map(holds.map(row => [row.couponCode, row._count]));
    return items.filter(coupon => coupon.useLimit === null ||
      (placed.get(coupon.code) ?? 0) + (pending.get(coupon.code) ?? 0) < coupon.useLimit);
  }, { isolationLevel: "RepeatableRead" });
}
