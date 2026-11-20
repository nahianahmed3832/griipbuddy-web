import { z } from "zod";
import type { FulfillmentStatus, OrderStatus, PaymentMethod, PaymentStatus, SellerPreparationStatus } from "../../generated/prisma/enums.ts";
import { uuid } from "../commerce/checkout-types.ts";

const preparationStatuses = ["PREPARING", "READY", "HANDED_OFF"] as const;

export const sellerPreparationInput = z.object({
  orderId: uuid,
  next: z.enum(preparationStatuses),
}).strict();

export const sellerPreparationLabels = {
  PREPARING: "Preparing",
  READY: "Ready for pickup",
  HANDED_OFF: "Handed to GriipBuddy",
} satisfies Record<SellerPreparationStatus, string>;

export const sellerPreparationActions = {
  PREPARING: "Start preparing",
  READY: "Mark ready for pickup",
  HANDED_OFF: "Confirm handoff",
} satisfies Record<SellerPreparationStatus, string>;

export function sellerPaymentAllowsPreparation(payment: { method: PaymentMethod; status: PaymentStatus } | null): boolean {
  if (!payment) return false;
  return payment.method === "COD"
    ? payment.status === "AWAITING_COLLECTION" || payment.status === "COLLECTED"
    : payment.status === "PAID";
}

export function nextSellerPreparation(
  orderStatus: OrderStatus, fulfillmentStatus: FulfillmentStatus, preparation: SellerPreparationStatus | null, ownParcelPending = false,
): SellerPreparationStatus | null {
  if (orderStatus !== "PLACED" || (fulfillmentStatus === "SHIPPED" && !ownParcelPending) || fulfillmentStatus === "DELIVERED") return null;
  if (!preparation) return "PREPARING";
  if (preparation === "PREPARING") return "READY";
  return preparation === "READY" ? "HANDED_OFF" : null;
}
