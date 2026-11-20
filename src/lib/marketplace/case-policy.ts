import { z } from "zod";
import type { OrderCaseKind, OrderCaseStatus } from "../../generated/prisma/enums.ts";
import { MAX_CART_LINES, MAX_QUANTITY, validVariantId } from "../cart/model.ts";
import { canCancelFrom } from "../commerce/labels.ts";

export const caseKinds = ["RETURN", "DISPUTE", "CANCEL", "EXCHANGE"] as const;
export const activeCaseStatuses = ["OPEN", "IN_REVIEW", "RETURN_APPROVED", "PICKUP_SCHEDULED", "RETURN_RECEIVED", "REFUND_APPROVED", "CANCELLATION_APPROVED", "EXCHANGE_SHIPPED"] as const;
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
  PICKUP_SCHEDULED: "Pickup scheduled",
  REFUND_APPROVED: "Refund approved",
  CANCELLATION_APPROVED: "Cancellation approved · refund review",
  EXCHANGE_SHIPPED: "Replacement shipped",
  DECLINED: "Declined",
  RESOLVED: "Resolved",
  WITHDRAWN: "Withdrawn",
};

const revision = z.number().int().nonnegative();
const returnLines = z.array(z.object({
  orderItemId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  replacementVariantId: z.string().refine(validVariantId).optional(),
})).min(1).max(MAX_CART_LINES).refine(lines => new Set(lines.map(line => line.orderItemId)).size === lines.length);

const caseRevision = { caseId: z.uuid(), revision };
const staffNote = z.string().trim().min(3).max(1500);
const publicNote = z.preprocess(value => typeof value === "string" && !value.trim() ? undefined : value, staffNote.optional());
const reference = z.string().trim().min(3).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u);
export const caseOpenReceiptInput = z.object({ orderId: z.uuid(), requestId: z.uuid() });
export const caseCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), orderId: z.uuid(), kind: z.enum(caseKinds), note: z.string().trim().min(10).max(1500),
    lines: returnLines.optional(), requestId: z.uuid().optional() }),
  z.object({ action: z.literal("withdraw"), ...caseRevision }),
  z.object({ action: z.literal("review"), ...caseRevision, status: z.enum(ownerCaseStatuses), note: staffNote, publicNote }),
  z.object({ action: z.literal("receive"), ...caseRevision, disposition: z.enum(["RESTOCK", "HOLD"]), confirmed: z.literal(true) }),
  z.object({ action: z.literal("schedule-pickup"), ...caseRevision,
    pickupAt: z.union([z.iso.datetime(), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]),
    pickupReference: reference, note: staffNote }),
  z.object({ action: z.literal("approve-refund"), ...caseRevision, amountMinor: z.number().int().positive().max(2_147_483_647), note: staffNote }),
  z.object({ action: z.literal("ship-exchange"), ...caseRevision, trackingReference: reference, note: staffNote }),
  z.object({ action: z.literal("approve-cancellation"), ...caseRevision, note: staffNote }),
  z.object({ action: z.literal("process-refund"), ...caseRevision }),
]);
export type CaseCommand = z.infer<typeof caseCommand>;

export function caseActorRole(command: CaseCommand) {
  return command.action === "open" || command.action === "withdraw" ? "shopper" : "owner";
}

export function mayRequestReturn(order: { status: string; fulfillmentStatus: string }) {
  return order.status === "PLACED" && order.fulfillmentStatus === "DELIVERED";
}

export function mayRequestCancellation(order: { status: string; fulfillmentStatus: string }) {
  return order.status === "PLACED" && canCancelFrom.some(status => status === order.fulfillmentStatus);
}

export function mayWithdrawCase(status: OrderCaseStatus) {
  return status === "OPEN" || status === "IN_REVIEW";
}

export function ownerCaseTransitions(kind: OrderCaseKind, status: OrderCaseStatus, hasReturnLines = false): readonly (typeof ownerCaseStatuses[number])[] {
  if (status === "OPEN") return ["IN_REVIEW"];
  if (status === "IN_REVIEW") {
    if (kind === "RETURN" || kind === "EXCHANGE") return ["RETURN_APPROVED", "DECLINED"];
    if (kind === "CANCEL") return ["DECLINED"];
    return ["RESOLVED", "DECLINED"];
  }
  if ((status === "RETURN_APPROVED" && !hasReturnLines) || (status === "RETURN_RECEIVED" && kind === "RETURN") ||
      status === "REFUND_APPROVED" || status === "EXCHANGE_SHIPPED") return ["RESOLVED"];
  return [];
}
