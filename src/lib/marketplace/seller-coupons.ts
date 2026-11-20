import type { MarketId } from "../../config/markets.ts";
import { authorizeCommercialActor } from "../commerce/commercial-access.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { CatalogWriteError, OperationError } from "../staff/operation-error.ts";
import { couponCodeInput, couponConfiguration } from "./coupon-input.ts";

async function sellerShop(db: DbReader, sellerId: string) {
  const shop = await db.marketplaceShop.findUnique({ where: { ownerId: sellerId }, select: { id: true } });
  if (!shop) throw new CatalogWriteError("forbidden", "An approved seller shop is required.");
  return shop;
}

export async function listSellerCoupons(sellerId: string, marketId: MarketId) {
  return getDb().$transaction(async db => {
    const shop = await sellerShop(db, sellerId);
    await authorizeCommercialActor(db, { id: sellerId, kind: "seller" }, { marketId, sellerId: shop.id });
    return db.marketplaceCoupon.findMany({ where: { marketId, shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 100,
      select: { code: true, kind: true, value: true, enabled: true, endsAt: true, minimumMinor: true, useLimit: true, sellerAuthorId: true } });
  });
}

export async function createSellerCoupon(sellerId: string, marketId: MarketId, input: Record<string, unknown>) {
  return getDb().$transaction(async db => {
    const shop = await sellerShop(db, sellerId);
    await authorizeCommercialActor(db, { id: sellerId, kind: "seller" }, { marketId, sellerId: shop.id });
    const parsed = couponConfiguration.safeParse({ ...input, shopId: shop.id });
    if (!parsed.success || parsed.data.endsAt && parsed.data.endsAt <= new Date()) {
      throw new OperationError("Check the code, discount, minimum, future end date and order limit.");
    }
    const coupon = parsed.data;
    const added = await db.marketplaceCoupon.createMany({ skipDuplicates: true, data: [{ ...coupon, marketId, sellerAuthorId: sellerId }] });
    if (added.count) {
      await db.auditEvent.create({ data: { action: "COUPON_CHANGED", target: coupon.code,
        changes: { created: true, marketId, shopId: shop.id, sellerActor: sellerId, kind: coupon.kind, value: coupon.value } } });
    } else {
      const previous = await db.marketplaceCoupon.findFirst({ where: { code: coupon.code, marketId, shopId: shop.id,
        sellerAuthorId: sellerId, kind: coupon.kind, value: coupon.value, minimumMinor: coupon.minimumMinor,
        useLimit: coupon.useLimit, endsAt: coupon.endsAt }, select: { code: true } });
      if (!previous) throw new OperationError("That coupon code is already in use.");
    }
    return coupon.code;
  });
}

export async function disableSellerCoupon(sellerId: string, marketId: MarketId, raw: unknown) {
  const code = couponCodeInput.parse(raw);
  return getDb().$transaction(async db => {
    const shop = await sellerShop(db, sellerId);
    await authorizeCommercialActor(db, { id: sellerId, kind: "seller" }, { marketId, sellerId: shop.id });
    const where = { code, marketId, shopId: shop.id, sellerAuthorId: sellerId };
    const saved = await db.marketplaceCoupon.findFirst({ where, select: { code: true } });
    if (!saved) throw new CatalogWriteError("forbidden", "This coupon is outside your management scope.");
    const change = await db.marketplaceCoupon.updateMany({ where: { ...where, enabled: true }, data: { enabled: false } });
    if (change.count) {
      await db.auditEvent.create({ data: { action: "COUPON_CHANGED", target: code,
        changes: { enabled: false, marketId, shopId: shop.id, sellerActor: sellerId } } });
    }
  });
}
