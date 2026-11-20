import type { Prisma } from "../../generated/prisma/client.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { lockConnectedOrderAttempt } from "../commerce/order-inventory.ts";
import { paypalSandboxConfig } from "../commerce/paypal-config.ts";
import { inspectSandboxRefund, refundSandboxCaseCapture, samePayPalAmount } from "../commerce/paypal-provider.ts";
import { finishPaymentEvent, paymentEventDigest, recordPaymentEvent } from "../commerce/provider-payment-events.ts";
import { getDb } from "../db/client.ts";
import { authorize, authorizeOrderOperation } from "../staff/operations.ts";
import { OrderCaseError } from "./case-error.ts";
import { itemizedAmount, remainingRefundBalance } from "./case-money.ts";

const retryWindow = 5 * 60 * 60 * 1000;
const transaction = { maxWait: 5_000, timeout: 42_000 };
const details = {
  orderCase: { select: {
    id: true, kind: true, status: true, revision: true, refundAmountMinor: true,
    returnLines: { select: { quantity: true, settlementUnitOffset: true,
      orderItem: { select: { quantity: true, lineTotalMinor: true, taxAllocatedMinor: true } } } },
    order: { select: {
      id: true, attemptId: true, marketId: true, currency: true, status: true, measurementTest: true, commerceEvidence: true,
      subtotalMinor: true, discountMinor: true, taxMinor: true, totalMinor: true, payment: true,
      attempt: { select: { paypal: { select: { captureId: true, providerAccountKey: true, refundStartedAt: true } } } },
    } },
  } },
} as const satisfies Prisma.OrderCaseRefundInclude;
type Refund = Prisma.OrderCaseRefundGetPayload<{ include: typeof details }>;
type Tx = Prisma.TransactionClient;

async function lockedRefund(tx: Tx, caseId: string) {
  const row = await tx.orderCase.findUnique({ where: { id: caseId }, select: { orderId: true } });
  if (!row) throw new OrderCaseError("Case not found.", 404);
  await lockConnectedOrderAttempt(tx, row.orderId);
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${row.orderId}::uuid FOR UPDATE`;
  const refund = await tx.orderCaseRefund.findUnique({ where: { caseId }, include: details });
  if (!refund) throw new OrderCaseError("Approve the exact refund amount before processing it.", 409);
  return refund;
}

function paypalBinding(refund: Refund) {
  const { order } = refund.orderCase;
  const session = order.attempt.paypal;
  const payment = order.payment;
  const config = paypalSandboxConfig(order.marketId);
  const exact = refund.orderCase.returnLines.length ? itemizedAmount(refund.orderCase.returnLines)
    : refund.orderCase.kind === "CANCEL" && order.status === "CANCELLED" && payment?.amountMinor === order.totalMinor ? order.totalMinor : null;
  if (refund.method !== "PAYPAL" || !config?.clientId || !config.clientSecret || !config.accountKey ||
    session?.providerAccountKey !== config.accountKey || !session.captureId || session.refundStartedAt || !order.measurementTest ||
    order.commerceEvidence === "production" || order.currency !== "USD" || refund.currency !== order.currency ||
    refund.orderCase.refundAmountMinor !== refund.amountMinor || refund.orderCase.status !== "REFUND_APPROVED" ||
    payment?.method !== "PAYPAL" || payment.currency !== refund.currency || !["PAID", "REFUND_PENDING"].includes(payment.status) ||
    exact === null || exact < refund.amountMinor) {
    throw new OrderCaseError("This refund requires reconciliation against the original verified payment and order snapshots.", 409);
  }
  return { accountKey: config.accountKey, captureId: session.captureId, order };
}

async function reconcileCaseRefund(caseId: string, actorId: string | null, callbackRefundId?: string) {
  return getDb().$transaction(async tx => {
    if (actorId) await authorize(tx, actorId, true);
    const refund = await lockedRefund(tx, caseId);
    if (actorId) await authorizeOrderOperation(tx, actorId, refund.orderCase.order.marketId, true);
    if (refund.state === "CONFIRMED" || refund.state === "FAILED") return { id: caseId, state: refund.state };
    const { accountKey, captureId, order } = paypalBinding(refund);
    if (refund.state !== "PROCESSING" || !refund.startedAt ||
      (callbackRefundId && refund.providerRefundId && refund.providerRefundId !== callbackRefundId)) {
      throw new OrderCaseError("The provider refund is outside the recorded processing attempt.", 409);
    }
    if (!refund.providerRefundId && !callbackRefundId && (!actorId || Date.now() - refund.startedAt.getTime() >= retryWindow)) {
      return { id: caseId, state: refund.state };
    }
    const providerRefundId = refund.providerRefundId ?? callbackRefundId;
    const observed = providerRefundId ? await inspectSandboxRefund(providerRefundId) : await refundSandboxCaseCapture(captureId, caseId, refund.amountMinor);
    const parent = observed.links?.find(link => link.rel === "up");
    const parentIsDifferent = parent && !["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"]
      .some(origin => parent.href === `${origin}/v2/payments/captures/${captureId}`);
    if ((providerRefundId && observed.id !== providerRefundId) || observed.custom_id !== caseId || parentIsDifferent ||
        !samePayPalAmount(observed.amount, refund.amountMinor)) {
      throw new OrderCaseError("The refund confirmation does not match the authorized currency, amount and case.", 409);
    }
    const state = observed.status === "COMPLETED" ? "CONFIRMED" : ["FAILED", "CANCELLED"].includes(observed.status) ? "FAILED" : "PROCESSING";
    if (state !== "PROCESSING") {
      const event = await recordPaymentEvent(tx, { provider: "PAYPAL", accountKey, eventKey: `case-refund:${observed.id}`,
        marketId: order.marketId, attemptId: order.attemptId, eventType: state === "CONFIRMED" ? "CASE_REFUND_CONFIRMED" : "CASE_REFUND_FAILED",
        evidenceHash: paymentEventDigest([caseId, captureId, observed.id, observed.status, refund.amountMinor, refund.currency]),
        providerReference: observed.id, currency: refund.currency, amountMinor: refund.amountMinor,
      });
      await finishPaymentEvent(tx, event, state === "CONFIRMED" ? "PROCESSED" : "FAILED");
      await tx.auditEvent.create({ data: {
        actorId, action: state === "CONFIRMED" ? "ORDER_CASE_REFUND_CONFIRMED" : "ORDER_CASE_REFUND_FAILED", target: caseId,
        changes: { orderId: order.id, operationId: caseId, currency: refund.currency, amountMinor: refund.amountMinor, providerRefundId: observed.id },
      } });
    }
    await tx.orderCaseRefund.update({ where: { caseId }, data: { state, providerRefundId: observed.id,
      ...(state === "CONFIRMED" && { confirmedAt: new Date() }) } });
    if (state === "CONFIRMED") {
      const total = await tx.orderCaseRefund.aggregate({
        where: { orderCase: { orderId: order.id }, method: "PAYPAL", currency: refund.currency, state }, _sum: { amountMinor: true },
      });
      if ((total._sum.amountMinor ?? 0) === order.payment?.amountMinor) {
        await tx.payment.update({ where: { orderId: order.id }, data: { status: "REFUNDED" } });
      }
    }
    return { id: caseId, state };
  }, transaction);
}

export async function processOrderCaseRefund(actorId: string, command: { caseId: string; revision: number }) {
  const { caseId, revision } = command;
  const state = await getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    const refund = await lockedRefund(tx, caseId);
    await authorizeOrderOperation(tx, actorId, refund.orderCase.order.marketId, true);
    if (refund.orderCase.revision !== revision) throw new OrderCaseError("This case changed. Refresh it and try again.", 409);
    if (refund.state !== "AUTHORIZED") return refund.state;
    const { order } = paypalBinding(refund);
    if (refund.amountMinor > await remainingRefundBalance(tx, order, caseId)) {
      throw new OrderCaseError("Prior refund approvals already use this payment balance.", 409);
    }
    await tx.orderCaseRefund.update({ where: { caseId }, data: { state: "PROCESSING", startedAt: new Date() } });
    await tx.auditEvent.create({ data: { actorId, action: "ORDER_CASE_REFUND_PROCESSING", target: caseId,
      changes: { orderId: order.id, operationId: caseId, amountMinor: refund.amountMinor, currency: refund.currency },
    } });
    return "PROCESSING";
  });
  return state === "PROCESSING" ? reconcileCaseRefund(caseId, actorId) : { id: caseId, state };
}

export async function paypalCaseRefundTarget(refundId: string, caseHint?: string) {
  const known = await getDb().orderCaseRefund.findFirst({
    where: { method: "PAYPAL", OR: [{ providerRefundId: refundId },
      ...(uuid.safeParse(caseHint).success ? [{ caseId: caseHint, state: "PROCESSING" as const }] : [])] },
    select: { caseId: true, amountMinor: true, orderCase: { select: { order: { select: {
      attemptId: true, marketId: true, attempt: { select: { paypal: { select: { providerAccountKey: true } } } },
    } } } } },
  });
  return known && { caseId: known.caseId, amountMinor: known.amountMinor, ...known.orderCase.order,
    accountKey: known.orderCase.order.attempt.paypal?.providerAccountKey };
}

export function reconcilePayPalOrderCaseRefund(caseId: string, refundId: string) {
  return reconcileCaseRefund(caseId, null, refundId);
}
