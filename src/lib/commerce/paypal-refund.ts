import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { authorize, OperationError } from "../staff/operations.ts";
import { canCancelFrom } from "./labels.ts";
import { orderDetails } from "./orders.ts";
import { lockConnectedOrderAttempt, releaseUnshippedOrderStock } from "./order-inventory.ts";
import { paypalSandboxConfig } from "./paypal-config.ts";
import { uuid } from "./checkout-types.ts";
import { inspectSandboxRefund, refundSandboxCapture, samePayPalAmount } from "./paypal-provider.ts";

async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  return tx.order.findUnique({ where: { id: orderId }, include: orderDetails });
}

export type PayPalRefundResult = "pending" | "refunded";

async function settleRefund(orderId: string, allowProviderRequest: boolean): Promise<PayPalRefundResult> {
  return getDb().$transaction(async tx => {
    const connectedAttempt = await lockConnectedOrderAttempt(tx, orderId);
    const order = await lockOrder(tx, orderId);
    if (order?.payment?.method !== "PAYPAL") throw new OperationError("PayPal sandbox order unavailable.");
    if (order.payment.status === "REFUNDED") return "refunded";
    if (order.payment.status !== "REFUND_PENDING") throw new OperationError("This order has no pending refund.");
    const session = await tx.payPalCheckout.findUnique({ where: { attemptId: order.attemptId } });
    if (!session?.captureId || session.providerAccountKey !== paypalSandboxConfig(order.marketId)?.accountKey || !session.refundStartedAt || !session.refundActorId) throw new OperationError("The PayPal refund record is unavailable.");
    if (!session.refundId && (!allowProviderRequest || Date.now() - session.refundStartedAt.getTime() >= 5 * 60 * 60 * 1000)) {
      return "pending";
    }

    const observed = session.refundId
      ? await inspectSandboxRefund(session.refundId)
      : await refundSandboxCapture(session.captureId, order.attemptId);
    if ((session.refundId && observed.id !== session.refundId) || !samePayPalAmount(observed.amount, order.totalMinor)) {
      throw new Error("Provider refund amount does not match the order.");
    }
    if (!session.refundId) {
      await tx.payPalCheckout.update({ where: { attemptId: order.attemptId }, data: { refundId: observed.id } });
    }
    if (observed.status !== "COMPLETED") return "pending";

    await tx.payment.update({ where: { orderId }, data: { status: "REFUNDED" } });
    await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await releaseUnshippedOrderStock(tx, session.refundActorId, connectedAttempt, order.items, observed.id);
    await tx.orderParcel.updateMany({ where: { orderId, status: "PLANNED", cancelledAt: null },
      data: { cancelledAt: new Date(), trackingRevision: { increment: 1 } } });
    // Staff audit and the order event are committed atomically with the restored stock.
    const actor = await tx.user.findUnique({ where: { id: session.refundActorId }, select: { id: true } });
    await tx.fulfillmentEvent.create({
      data: { orderId, actorId: actor?.id, status: order.fulfillmentStatus, type: "ORDER_CANCELLED" },
    });
    await tx.auditEvent.create({
      data: { actorId: actor?.id, action: "ORDER_CANCELLED", target: orderId,
        changes: { method: "PAYPAL_SANDBOX_REFUND", restoredLines: order.items.length } },
    });
    return "refunded";
  }, { maxWait: 5_000, timeout: 32_000 });
}

export async function refundPayPalOrder(actorId: string, orderId: string): Promise<PayPalRefundResult> {
  if (!uuid.safeParse(orderId).success) throw new OperationError("PayPal sandbox order unavailable.");
  const config = paypalSandboxConfig();
  if (!config?.clientId || !config.clientSecret || !config.accountKey) throw new OperationError("PayPal sandbox is unavailable.");
  const state = await getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockConnectedOrderAttempt(tx, orderId);
    const order = await lockOrder(tx, orderId);
    if (order?.payment?.method !== "PAYPAL") throw new OperationError("PayPal sandbox order unavailable.");
    if (order.payment.status === "REFUNDED") return "refunded";
    if (await tx.orderCase.findFirst({ where: { orderId, OR: [
      { refundAmountMinor: { not: null } }, { kind: "CANCEL", status: { in: ["OPEN", "IN_REVIEW", "CANCELLATION_APPROVED"] } },
    ] }, select: { id: true } })) throw new OperationError("Open the existing cancellation or refund case to reconcile this payment.");
    const session = await tx.payPalCheckout.findUnique({ where: { attemptId: order.attemptId }, select: { providerAccountKey: true } });
    if (order.marketId !== config.marketId || session?.providerAccountKey !== config.accountKey) throw new OperationError("The payment account requires reconciliation.");
    if (order.payment.status === "REFUND_PENDING") return "pending";
    if (order.status !== "PLACED" || order.payment.status !== "PAID" || !canCancelFrom.includes(order.fulfillmentStatus)) {
      throw new OperationError("Only unshipped paid PayPal sandbox orders can be cancelled and refunded here.");
    }
    if (await tx.orderParcel.findFirst({ where: { orderId, status: { not: "PLANNED" } }, select: { id: true } })) {
      throw new OperationError("This order has a dispatched parcel.");
    }
    await tx.payPalCheckout.update({ where: { attemptId: order.attemptId }, data: {
      refundStartedAt: new Date(), refundActorId: actorId,
    } });
    await tx.payment.update({ where: { orderId }, data: { status: "REFUND_PENDING" } });
    return "pending";
  });
  return state === "refunded" ? state : settleRefund(orderId, true);
}

export async function reconcilePayPalRefund(refundId: string) {
  const config = paypalSandboxConfig();
  if (!config?.accountKey) return;
  const session = await getDb().payPalCheckout.findUnique({
    where: { refundId, providerAccountKey: config.accountKey, attempt: { marketId: config.marketId } }, select: { attempt: { select: { order: { select: { id: true } } } } },
  });
  if (session?.attempt.order) await settleRefund(session.attempt.order.id, false);
}
