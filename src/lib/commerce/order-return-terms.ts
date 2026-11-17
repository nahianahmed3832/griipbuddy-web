import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";

const storedTerms = z.object({
  version: z.string().min(1),
  marketId: z.string().min(1),
  returnRequest: z.enum(["item", "order", "support"]),
  onlineCancellation: z.boolean(),
  summary: z.object({ en: z.string().min(1) }).catchall(z.string().min(1)),
});

type ReturnTerms = z.infer<typeof storedTerms>;

const checkoutTerms = {
  bd: {
    version: "bd-preview-v1", marketId: "bd", returnRequest: "item", onlineCancellation: true,
    summary: {
      en: "After delivery, request a return for the items from this order. Support reviews each request and provides instructions. If a refund applies, staff confirm it after receiving the returned items and recording the payout.",
      bn: "ডেলিভারির পর এই অর্ডারের পণ্য ফেরত দেওয়ার অনুরোধ করুন। সহায়তা দল প্রতিটি অনুরোধ পর্যালোচনা করে নির্দেশনা দেবে। টাকা ফেরত প্রযোজ্য হলে কর্মীরা ফেরত পণ্য গ্রহণ ও টাকা পাঠানোর তথ্য নথিভুক্ত করার পর তা নিশ্চিত করবেন।",
    },
  },
  us: {
    version: "us-paypal-preview-v1", marketId: "us", returnRequest: "order", onlineCancellation: false,
    summary: { en: "After delivery, ask support to review a return for this order and provide instructions. Eligible PayPal sandbox refunds go back to the original payment." },
  },
} as const satisfies Partial<Record<MarketId, ReturnTerms>>;

export function returnTermsForCheckout(marketId: keyof typeof checkoutTerms) {
  return checkoutTerms[marketId];
}

type Purchase = { marketId: MarketId; returnTerms: unknown };

export function recordedReturnTerms({ marketId, returnTerms }: Purchase): ReturnTerms | null {
  const parsed = storedTerms.safeParse(returnTerms);
  return parsed.success && parsed.data.marketId === marketId ? parsed.data : null;
}

export function purchaseCaseOptions(order: Purchase): Pick<ReturnTerms, "returnRequest" | "onlineCancellation"> {
  const recorded = recordedReturnTerms(order);
  if (recorded) return recorded;
  // Older orders have no authoritative terms copy. Keep their existing support paths available.
  if (order.marketId === "bd") return { returnRequest: "item", onlineCancellation: true };
  if (order.marketId === "us") return { returnRequest: "order", onlineCancellation: false };
  return { returnRequest: "support", onlineCancellation: false };
}
