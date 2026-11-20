"use client";

import Link from "next/link";
import type { MarketId } from "@/config/markets";
import { usePendingCheckout } from "@/lib/cart/checkout-attempt";
import { usePendingPaypal } from "@/lib/cart/paypal-attempt";

export function PendingCheckout({ marketId }: { marketId: MarketId }) {
  const attempt = usePendingCheckout(marketId);
  const paypal = usePendingPaypal(marketId);
  if (!attempt && !paypal) return null;
  const payment = attempt ? attempt.prepaid : Boolean(paypal);
  return (
    <p className="cart-notice" role="status">
      <span>{payment ? "A payment needs a status check." : "An order attempt needs a status check."}{" "}
        <Link className="text-link" href="/checkout">{payment ? "Check payment status" : "Check your last order"}</Link>
      </span>
    </p>
  );
}
