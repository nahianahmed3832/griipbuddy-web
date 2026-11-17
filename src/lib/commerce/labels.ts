import type { FulfillmentStatus, OrderStatus, PaymentMethod, PaymentStatus } from "../../generated/prisma/enums.ts";

import { markets, type MarketId } from "../../config/markets.ts";
import { manualPaymentLabels } from "./manual-payment-methods.ts";

export const fulfillmentLabels: Record<FulfillmentStatus, string> = {
  UNFULFILLED: "Unfulfilled", PACKING: "Packing", READY_TO_SHIP: "Ready to ship", SHIPPED: "Shipped", DELIVERED: "Delivered",
};
export const paymentLabels: Record<PaymentStatus, string> = {
  AWAITING_COLLECTION: "Awaiting collection", COLLECTED: "Collected", VOIDED: "Voided",
  AWAITING_VERIFICATION: "Awaiting payment verification",
  PAID: "Paid", REFUND_PENDING: "Refund pending", REFUNDED: "Refunded",
};
export const paymentMethodLabels: Record<PaymentMethod, string> = {
  COD: "Cash on delivery", PAYPAL: "PayPal sandbox", SSLCOMMERZ: "SSLCOMMERZ", ...manualPaymentLabels,
};
export const orderLabels: Record<OrderStatus, string> = { PLACED: "Placed", CANCELLED: "Cancelled" };
export const nextFulfillment: Partial<Record<FulfillmentStatus, FulfillmentStatus>> = {
  UNFULFILLED: "PACKING", PACKING: "READY_TO_SHIP", READY_TO_SHIP: "SHIPPED", SHIPPED: "DELIVERED",
};
export const canCancelFrom: readonly FulfillmentStatus[] = ["UNFULFILLED", "PACKING", "READY_TO_SHIP"];

export function orderDate(date: Date, marketId: MarketId = "bd") {
  const { locale, timeZone } = markets[marketId];
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium", timeStyle: "short", timeZone,
  }).format(date);
}
