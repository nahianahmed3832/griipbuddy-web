import type { DbReader } from "../db/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { CommerceError } from "../commerce/errors.ts";
import { applyCoupon, type CouponTerms } from "./coupon-input.ts";

export async function checkoutCoupon(db: DbReader, marketId: MarketId, code: string, lines: readonly { shopId: string; netMinor: number }[]) {
  const coupon = await db.marketplaceCoupon.findUnique({ where: { code, marketId } });
  if (!coupon || !coupon.enabled || (coupon.endsAt && coupon.endsAt <= new Date())) {
    throw new CommerceError({ kind: "unavailable", message: "This coupon is unavailable. Remove it or use another code." });
  }
  if (coupon.useLimit !== null) {
    // Read both counts in the same database snapshot. A paid checkout atomically
    // moves one redemption from the reservation to its confirmed order.
    const [use] = await db.$queryRaw<{ total: bigint }[]>`
      SELECT (
        (SELECT count(*) FROM "Order" WHERE "couponCode" = ${code} AND "marketId" = ${marketId}::"MarketCode") +
        (SELECT count(*) FROM "PrepaidCheckout" p JOIN "CheckoutAttempt" a ON a."id" = p."attemptId"
          WHERE p."couponCode" = ${code} AND a."marketId" = ${marketId}::"MarketCode" AND p."state" IN ('PREPARING', 'AWAITING_PAYMENT'))
      ) AS total
    `;
    if (use.total >= coupon.useLimit) {
      throw new CommerceError({ kind: "unavailable", message: "This coupon has reached its order limit. Remove it or use another code." });
    }
  }
  // Database constraints enforce the discount kinds and ranges.
  const result = applyCoupon({ ...coupon, kind: coupon.kind as CouponTerms["kind"] }, lines);
  if (!result) {
    throw new CommerceError({ kind: "unavailable", message: "The items in your cart do not qualify for this coupon." });
  }
  return result;
}
