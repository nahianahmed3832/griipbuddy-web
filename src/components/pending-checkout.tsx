"use client";

import Link from "next/link";
import { usePendingCheckout } from "@/lib/cart/checkout-attempt";

export function PendingCheckout() {
  const attempt = usePendingCheckout();
  if (!attempt) return null;
  return (
    <p className="cart-notice" role="status">
      <span>An order attempt needs a status check. <Link className="text-link" href="/checkout">Check your last order</Link></span>
    </p>
  );
}
