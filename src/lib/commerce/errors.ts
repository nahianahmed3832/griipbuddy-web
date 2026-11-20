import type { CheckoutFailure } from "./checkout-types.ts";

export class CommerceError extends Error {
  constructor(readonly detail: CheckoutFailure) {
    super(detail.message);
    this.name = "CommerceError";
  }
}

export const checkoutClosed = "Checkout is unavailable for this market.";
