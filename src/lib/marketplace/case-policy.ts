import { z } from "zod";
import type { OrderCaseKind, OrderCaseStatus } from "../../generated/prisma/enums.ts";
import type { MarketId } from "../../config/markets.ts";
import { MAX_CART_LINES, MAX_QUANTITY, validVariantId } from "../cart/model.ts";
import { canCancelFrom } from "../commerce/labels.ts";
import { isManualPaymentMethod } from "../commerce/manual-payment-methods.ts";
import { purchaseCaseOptions } from "../commerce/order-return-terms.ts";
import { storeShop } from "./constants.ts";

export const caseKinds = ["RETURN", "DISPUTE", "CANCEL", "EXCHANGE"] as const;
export const caseReasons = ["DELIVERY", "DAMAGED", "WRONG_ITEM", "CHANGED_MIND", "PAYMENT", "OTHER"] as const;
export type CaseReason = typeof caseReasons[number];
export const pendingCancellationStatuses = ["OPEN", "IN_REVIEW"] as const;
export const activeCaseStatuses = [...pendingCancellationStatuses, "RETURN_APPROVED", "RETURN_RECEIVED", "EXCHANGE_SHIPPED", "REFUND_APPROVED", "REFUND_FAILED"] as const;
export const ownerCaseStatuses = ["IN_REVIEW", "RETURN_APPROVED", "DECLINED", "RESOLVED"] as const;
export const caseKindLabels: Record<OrderCaseKind, string> = {
  RETURN: "Return request",
  DISPUTE: "Order dispute",
  CANCEL: "Cancellation request",
  EXCHANGE: "Exchange request",
};
export const caseStatusLabels: Record<OrderCaseStatus, string> = {
  OPEN: "Submitted",
  IN_REVIEW: "In review",
  RETURN_APPROVED: "Return approved",
  RETURN_RECEIVED: "Return received",
  EXCHANGE_SHIPPED: "Replacement shipped",
  REFUND_APPROVED: "Refund pending",
  REFUND_FAILED: "Refund retry needed",
  DECLINED: "Declined",
  RESOLVED: "Resolved",
  WITHDRAWN: "Withdrawn",
};

const revision = z.number().int().nonnegative();
const reply = z.string().trim().min(3).max(1500);
const singleLine = (max: number) => z.string().trim().min(2).max(max).regex(/^[^\p{Cc}]+$/u);
export const returnLines = z.array(z.object({
  orderItemId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  replacementVariantId: z.string().refine(validVariantId).optional(),
})).min(1).max(MAX_CART_LINES).refine(lines => new Set(lines.map(line => line.orderItemId)).size === lines.length);

export const caseCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), orderId: z.uuid(), kind: z.enum(caseKinds), note: z.string().trim().min(10).max(1500),
    reason: z.enum(caseReasons).optional(), issueItemId: z.uuid().optional(), lines: returnLines.optional() }),
  z.object({ action: z.literal("withdraw"), caseId: z.uuid(), revision }),
  z.object({ action: z.literal("reply"), caseId: z.uuid(), revision, note: reply }),
  z.object({ action: z.literal("respond"), caseId: z.uuid(), revision, note: reply }),
  z.object({ action: z.literal("review"), caseId: z.uuid(), revision, status: z.enum(ownerCaseStatuses), note: reply }),
  z.object({ action: z.literal("receive"), caseId: z.uuid(), revision, disposition: z.enum(["RESTOCK", "HOLD"]), confirmed: z.literal(true) }),
  z.object({ action: z.literal("approve-cancellation"), caseId: z.uuid(), revision, note: reply }),
  z.object({ action: z.literal("approve-refund"), caseId: z.uuid(), revision, amountMinor: z.int().min(1).max(2_147_483_647), note: reply }),
  z.object({ action: z.literal("fail-refund"), caseId: z.uuid(), revision, note: reply }),
  z.object({ action: z.literal("ship-exchange"), caseId: z.uuid(), revision, carrier: singleLine(60), trackingReference: singleLine(80), note: reply }),
  z.object({ action: z.literal("confirm-refund"), caseId: z.uuid(), revision, amountMinor: z.int().min(1).max(2_147_483_647),
    method: singleLine(60), reference: singleLine(80), confirmed: z.literal(true) }),
]);
export type CaseCommand = z.infer<typeof caseCommand>;

export function caseActorRole(action: CaseCommand["action"]) {
  return action === "open" || action === "reply" || action === "withdraw" ? "shopper" : "owner";
}

export function mayRequestReturn(order: { status: string; fulfillmentStatus: string }) {
  return order.status === "PLACED" && order.fulfillmentStatus === "DELIVERED";
}

export function mayRequestCancellation(order: { status: string; fulfillmentStatus: string }) {
  return order.status === "PLACED" && canCancelFrom.some(status => status === order.fulfillmentStatus);
}

type BangladeshCancellationOrder = {
  marketId: MarketId;
  status: string;
  fulfillmentStatus: string;
  totalMinor: number;
  payment: { status: string; method: string; currency: string; amountMinor: number } | null;
  trackingReference: string | null;
  shippingWarehouseId: string | null;
  bangladeshShipment: unknown;
  sellerFulfillments: readonly { status: string }[];
};

export function paidBangladeshCancellationAmount(order: BangladeshCancellationOrder) {
  const payment = order.payment;
  if (!payment || payment.status !== "PAID" || payment.currency !== "BDT" || payment.amountMinor <= 0 ||
      payment.amountMinor !== order.totalMinor) return 0;
  return payment.method === "SSLCOMMERZ" || isManualPaymentMethod(payment.method) ? payment.amountMinor : 0;
}

export function mayRequestBangladeshCancellation(order: BangladeshCancellationOrder) {
  return order.marketId === "bd" && mayRequestCancellation(order) && !order.trackingReference && !order.shippingWarehouseId &&
    !order.bangladeshShipment && !order.sellerFulfillments.some(fulfillment => fulfillment.status === "HANDED_OFF") &&
    (order.payment?.method === "COD" && order.payment.status === "AWAITING_COLLECTION" &&
      order.payment.currency === "BDT" && order.payment.amountMinor === order.totalMinor ||
      paidBangladeshCancellationAmount(order) > 0);
}

export function mayCancelBangladeshOrderImmediately(order: BangladeshCancellationOrder & {
  items: readonly { marketplaceShopId: string | null }[];
}) {
  return mayRequestBangladeshCancellation(order) && order.fulfillmentStatus === "UNFULFILLED" &&
    order.payment?.method === "COD" && order.items.length > 0 &&
    order.items.every(item => !item.marketplaceShopId || item.marketplaceShopId === storeShop.id);
}

export function mayRequestExchange(order: {
  marketId: MarketId;
  status: string;
  fulfillmentStatus: string;
  returnTerms: unknown;
}) {
  return order.marketId === "bd" && mayRequestReturn(order) && purchaseCaseOptions(order).returnRequest === "item";
}

export function mayWithdrawCase(status: OrderCaseStatus) {
  return status === "OPEN" || status === "IN_REVIEW";
}

export function ownerCaseTransitions(kind: OrderCaseKind, status: OrderCaseStatus, hasReturnLines = false): readonly (typeof ownerCaseStatuses[number])[] {
  if (status === "OPEN") return ["IN_REVIEW"];
  if (status === "IN_REVIEW") return [kind === "RETURN" || kind === "EXCHANGE" ? "RETURN_APPROVED" : "RESOLVED", "DECLINED"];
  if ((kind === "RETURN" && ((status === "RETURN_APPROVED" && !hasReturnLines) || status === "RETURN_RECEIVED")) ||
      (kind === "EXCHANGE" && status === "EXCHANGE_SHIPPED")) return ["RESOLVED"];
  return [];
}
