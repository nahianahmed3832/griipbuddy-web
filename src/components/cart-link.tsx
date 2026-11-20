"use client";

import { CircleAlert, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { useCartPricing } from "./cart-pricing";

export function CartLink() {
  const { cart, totalSaved, market } = useCartPricing();
  const affected = cart?.affectedLines ?? 0;
  const attention = affected > 0 ? `Some items need attention in ${market.name}.` : "";
  return (
    <Link
      className="cart-link"
      data-empty={totalSaved === 0 || undefined}
      href="/cart"
      aria-label={`Cart, ${totalSaved} ${totalSaved === 1 ? "item" : "items"}${attention ? `. ${attention}` : ""}`}
      title={attention || undefined}
    >
      <ShoppingCart aria-hidden="true" size={21} strokeWidth={1.8} />
      <span aria-hidden="true" className="cart-link__count">{totalSaved}{affected > 0 && <CircleAlert className="cart-link__alert" size={15} />}</span>
      <span role="status" className="sr-only">{attention}</span>
    </Link>
  );
}
