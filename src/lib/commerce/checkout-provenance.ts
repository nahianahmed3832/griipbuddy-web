import type { MarketId } from "../../config/markets.ts";
import { checkoutCartMatches } from "../cart/shared-cart.ts";
import type { DbReader } from "../db/client.ts";
import type { CheckoutCartContext, CheckoutCartItem } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";

export function checkoutReviewActor(shopperId: string | null | undefined) {
  // Unbound attempts from earlier callers remain readable with their original guest proof.
  return shopperId === undefined ? null : shopperId === null ? "guest" : `shopper:${shopperId}`;
}

export function validateReviewActor(attempt: { reviewActor: string | null }, shopperId?: string | null) {
  return attempt.reviewActor === null || attempt.reviewActor === checkoutReviewActor(shopperId ?? null);
}

export async function validateCheckoutCart(db: DbReader, input: {
  marketId: MarketId; cart?: CheckoutCartContext; items: readonly CheckoutCartItem[];
}, shopperId?: string | null, lock = false) {
  if (input.cart?.source === "buy-now" && input.items.length !== 1) {
    throw new CommerceError({ kind: "invalid", message: "Buy now supports a single selected item." });
  }
  if (shopperId && input.cart?.source === "cart" &&
      !await checkoutCartMatches(shopperId, input.marketId, input.cart, input.items, db, lock)) {
    throw new CommerceError({ kind: "conflict", message: "Your cart changed. Return to the cart and review the current items before placing your order." });
  }
}
