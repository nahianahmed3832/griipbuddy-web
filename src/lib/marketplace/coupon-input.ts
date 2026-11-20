import { z } from "zod";

export const couponCodeInput = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/);

export const couponConfiguration = z.object({
  code: couponCodeInput,
  shopId: z.uuid().nullable(),
  kind: z.enum(["PERCENT", "FIXED"]),
  value: z.number().int().positive().max(10_000_000),
  minimumMinor: z.number().int().min(0).max(10_000_000),
  useLimit: z.number().int().min(1).max(100_000).nullable(),
  endsAt: z.date().nullable(),
}).refine((coupon) => coupon.kind !== "PERCENT" || coupon.value <= 10_000);

export type CouponTerms = Pick<z.infer<typeof couponConfiguration>, "kind" | "value" | "shopId" | "minimumMinor">;

export function applyCoupon(terms: CouponTerms, lines: readonly { shopId: string; netMinor: number }[]) {
  const eligible = lines.map((line) => terms.shopId === null || line.shopId === terms.shopId ? line.netMinor : 0);
  const subtotal = eligible.reduce((total, amount) => total + amount, 0);
  if (!subtotal || subtotal < terms.minimumMinor) return null;

  const requested = terms.kind === "FIXED" ? terms.value : Math.floor(subtotal * terms.value / 10_000);
  const total = Math.min(requested, subtotal);
  if (!total) return null;

  let eligibleSoFar = 0;
  let allocated = 0;
  // Cumulative allocation keeps rounding exact even when a shop has many small lines.
  const discounts = eligible.map((amount) => {
    eligibleSoFar += amount;
    const throughLine = Number(BigInt(total) * BigInt(eligibleSoFar) / BigInt(subtotal));
    const atLine = throughLine - allocated;
    allocated = throughLine;
    return atLine;
  });
  return { total, discounts };
}
