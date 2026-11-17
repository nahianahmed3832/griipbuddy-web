import { z } from "zod";
import type { OrderCaseKind, OrderCaseStatus } from "../../generated/prisma/enums.ts";
import { MAX_CART_LINES, MAX_QUANTITY } from "../cart/model.ts";
import { canCancelFrom } from "../commerce/labels.ts";

export const caseKinds = ["RETURN", "DISPUTE", "CANCEL"] as const;
export const caseReasons = ["DELIVERY", "DAMAGED", "WRONG_ITEM", "CHANGED_MIND", "PAYMENT", "OTHER"] as const;
export type CaseReason = typeof caseReasons[number];
export const activeCaseStatuses = ["OPEN", "IN_REVIEW", "RETURN_APPROVED", "RETURN_RECEIVED"] as const;
export const ownerCaseStatuses = ["IN_REVIEW", "RETURN_APPROVED", "DECLINED", "RESOLVED"] as const;
export const caseKindLabels: Record<OrderCaseKind, string> = {
  RETURN: "Return request",
  DISPUTE: "Order dispute",
  CANCEL: "Cancellation request",
};
export const caseStatusLabels: Record<OrderCaseStatus, string> = {
  OPEN: "Submitted",
  IN_REVIEW: "In review",
  RETURN_APPROVED: "Return approved",
  RETURN_RECEIVED: "Return received",
  DECLINED: "Declined",
  RESOLVED: "Resolved",
  WITHDRAWN: "Withdrawn",
};

const revision = z.number().int().nonnegative();
const reply = z.string().trim().min(3).max(1500);
const singleLine = (max: number) => z.string().trim().min(2).max(max).regex(/^[^\p{Cc}]+$/u);
const returnLines = z.array(z.object({
  orderItemId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
})).min(1).max(MAX_CART_LINES).refine(lines => new Set(lines.map(line => line.orderItemId)).size === lines.length);

export const caseCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), orderId: z.uuid(), kind: z.enum(caseKinds), note: z.string().trim().min(10).max(1500),
    reason: z.enum(caseReasons).optional(), issueItemId: z.uuid().optional(), lines: returnLines.optional() }),
  z.object({ action: z.literal("withdraw"), caseId: z.uuid(), revision }),
  z.object({ action: z.literal("reply"), caseId: z.uuid(), revision, note: reply }),
  z.object({ action: z.literal("respond"), caseId: z.uuid(), revision, note: reply }),
  z.object({ action: z.literal("review"), caseId: z.uuid(), revision, status: z.enum(ownerCaseStatuses), note: reply }),
  z.object({ action: z.literal("receive"), caseId: z.uuid(), revision, disposition: z.enum(["RESTOCK", "HOLD"]), confirmed: z.literal(true) }),
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

export function mayWithdrawCase(status: OrderCaseStatus) {
  return status === "OPEN" || status === "IN_REVIEW";
}

export function ownerCaseTransitions(kind: OrderCaseKind, status: OrderCaseStatus, hasReturnLines = false): readonly (typeof ownerCaseStatuses[number])[] {
  if (status === "OPEN") return ["IN_REVIEW"];
  if (status === "IN_REVIEW") return [kind === "RETURN" ? "RETURN_APPROVED" : "RESOLVED", "DECLINED"];
  if ((status === "RETURN_APPROVED" && !hasReturnLines) || status === "RETURN_RECEIVED") return ["RESOLVED"];
  return [];
}
