import { Prisma } from "../../generated/prisma/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { variantQuantities } from "../cart/model.ts";
import { restoreBangladeshInventory } from "../commerce/bangladesh-returns.ts";
import { purchaseCaseOptions } from "../commerce/order-return-terms.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { authorize, cancelLockedUnshippedOrder, lockProductEdits, OperationError } from "../staff/operations.ts";
import { eligibleExchangeVariants, exchangeSource, type ExchangeSource } from "./case-exchange.ts";
import {
  activeCaseStatuses, caseActorRole, mayCancelBangladeshOrderImmediately, mayRequestBangladeshCancellation, mayRequestCancellation,
  mayRequestExchange, mayRequestReturn, mayWithdrawCase, ownerCaseTransitions, paidBangladeshCancellationAmount,
  pendingCancellationStatuses, type CaseCommand,
} from "./case-policy.ts";

export { exchangeVariantsForPurchase } from "./case-exchange.ts";

export class OrderCaseError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type CaseActor = { role: "shopper" | "owner"; id: string; market?: MarketId };
type OpenCommand = Extract<CaseCommand, { action: "open" }>;
type ReceiveCommand = Extract<CaseCommand, { action: "receive" }>;
type RefundCommand = Extract<CaseCommand, { action: "approve-refund" | "confirm-refund" | "fail-refund" }>;
type CancellationCommand = Extract<CaseCommand, { action: "approve-cancellation" }>;
type ExchangeCommand = Extract<CaseCommand, { action: "ship-exchange" }>;
type UpdateCommand = Exclude<CaseCommand, OpenCommand | ReceiveCommand | RefundCommand | CancellationCommand | ExchangeCommand>;

const summaryFields = { id: true, kind: true, status: true, updatedAt: true, reason: true,
  refundAmountMinor: true, refundConfirmedAt: true } satisfies Prisma.OrderCaseSelect;
const orderReference = { id: true, reference: true, marketId: true } satisfies Prisma.OrderSelect;
const recentFirst = [{ updatedAt: "desc" }, { id: "desc" }] satisfies Prisma.OrderCaseOrderByWithRelationInput[];
const returnLineItem = { id: true, productName: true, variantName: true, personalization: true } satisfies Prisma.OrderItemSelect;
const merchandiseKinds = ["RETURN", "EXCHANGE"] as const;
const cancellationOrder = {
  id: true, marketId: true, status: true, fulfillmentStatus: true, totalMinor: true,
  trackingReference: true, shippingWarehouseId: true, bangladeshShipment: { select: { orderId: true } },
  payment: { select: { method: true, status: true, amountMinor: true, currency: true } },
  sellerFulfillments: { where: { status: "HANDED_OFF" }, select: { status: true } },
} satisfies Prisma.OrderSelect;
export type OrderCaseSummary = Prisma.OrderCaseGetPayload<{ select: typeof summaryFields }>;

function shopperCaseWhere(orderId: string, shopperId: string, marketId?: MarketId): Prisma.OrderCaseWhereInput {
  return { orderId, order: { shopperId, marketId } };
}

export function casesForPurchase(orderId: string, shopperId: string, marketId?: MarketId) {
  return getDb().orderCase.findMany({
    where: shopperCaseWhere(orderId, shopperId, marketId), orderBy: recentFirst, take: 20, select: summaryFields,
  });
}

export function casesForShopper(shopperId: string, marketId: MarketId) {
  return getDb().orderCase.findMany({
    where: { order: { shopperId, marketId } }, orderBy: recentFirst, take: 30,
    select: { ...summaryFields, order: { select: orderReference } },
  });
}

export function itemsForSupport(orderId: string, shopperId: string, marketId: MarketId) {
  return getDb().orderItem.findMany({ where: { orderId, order: { shopperId, marketId } }, select: returnLineItem,
    orderBy: [{ sku: "asc" }, { id: "asc" }] });
}

async function receivedQuantities(db: DbReader, orderId: string) {
  const rows = await db.orderCaseReturnLine.groupBy({
    by: ["orderItemId"],
    where: { orderCase: { orderId, returnReceivedAt: { not: null } } },
    _sum: { quantity: true },
  });
  return new Map(rows.map(line => [line.orderItemId, line._sum.quantity ?? 0]));
}

function completedUnitemizedReturn(db: DbReader, orderId: string) {
  return db.orderCase.findFirst({
    where: { orderId, kind: "RETURN", status: "RESOLVED", returnLines: { none: {} } },
    select: { id: true },
  });
}

export async function returnItemsForPurchase(orderId: string, shopperId: string) {
  const db = getDb();
  const order = await db.order.findFirst({
    where: { id: orderId, shopperId, marketId: "bd", status: "PLACED", fulfillmentStatus: "DELIVERED" },
    select: { items: { select: { ...returnLineItem, quantity: true }, orderBy: [{ sku: "asc" }, { id: "asc" }] } },
  });
  if (!order) return [];
  if (await completedUnitemizedReturn(db, orderId)) return [];
  const received = await receivedQuantities(db, orderId);
  return order.items.map(item => ({ ...item, quantity: item.quantity - (received.get(item.id) ?? 0) }))
    .filter(item => item.quantity > 0);
}

export async function casesForStaffOrder(actorId: string, orderId: string) {
  const db = getDb();
  const { marketIds } = await authorize(db, actorId, true);
  return db.orderCase.findMany({ where: { orderId, order: { marketId: { in: marketIds } } }, orderBy: recentFirst, take: 20, select: summaryFields });
}

const detailFields = {
  ...summaryFields,
  revision: true,
  order: { select: { ...orderReference, currency: true } },
  issueItem: { select: returnLineItem },
  attachment: { select: { caseId: true } },
  refundMethod: true, replacementCarrier: true, replacementTrackingReference: true,
  returnLines: { select: { quantity: true, replacementVariantName: true, orderItem: { select: returnLineItem } }, orderBy: { orderItemId: "asc" } },
  events: {
    orderBy: { revision: "asc" },
    select: { status: true, note: true, revision: true, createdAt: true, shopperActorId: true, refundConfirmed: true },
  },
} satisfies Prisma.OrderCaseSelect;
export type OrderCaseDetail = Prisma.OrderCaseGetPayload<{ select: typeof detailFields }>;

export function buyerOrderCase(shopperId: string, orderId: string, caseId: string, marketId?: MarketId) {
  return getDb().orderCase.findFirst({ where: { id: caseId, ...shopperCaseWhere(orderId, shopperId, marketId) }, select: detailFields });
}

const refundFields = {
  id: true, kind: true, status: true, revision: true, returnReceivedAt: true,
  refundAmountMinor: true, refundMethod: true, refundReference: true, refundConfirmedAt: true,
  order: { select: { ...cancellationOrder, subtotalMinor: true, discountMinor: true, taxMinor: true } },
  returnLines: { select: { quantity: true, orderItem: { select: { quantity: true, lineTotalMinor: true } } } },
} satisfies Prisma.OrderCaseSelect;
type RefundCase = Prisma.OrderCaseGetPayload<{ select: typeof refundFields }>;

function receivedMerchandise(orderCase: RefundCase) {
  return merchandiseKinds.some(kind => kind === orderCase.kind) && Boolean(orderCase.returnReceivedAt) && orderCase.returnLines.length > 0;
}

function refundActions(orderCase: RefundCase, maxRefundMinor: number) {
  const available = orderCase.order.marketId === "bd" && !orderCase.refundConfirmedAt && maxRefundMinor > 0;
  const approved = orderCase.refundAmountMinor;
  const received = receivedMerchandise(orderCase);
  return {
    canApproveRefund: available && (
      received && orderCase.status === "RETURN_RECEIVED" ||
      orderCase.status === "REFUND_FAILED" && approved !== null && approved <= maxRefundMinor),
    canConfirmRefund: available && (
      orderCase.status === "REFUND_APPROVED" && approved !== null && approved <= maxRefundMinor ||
      received && orderCase.kind === "RETURN" && ["RETURN_RECEIVED", "RESOLVED"].includes(orderCase.status)),
  };
}

async function refundLimit(db: DbReader, orderCase: RefundCase) {
  const { order, returnLines } = orderCase;
  const payment = order.payment;
  if (order.marketId !== "bd" || !payment || payment.currency !== "BDT") return 0;
  if (orderCase.kind === "CANCEL") {
    return order.status === "CANCELLED" && payment.status === "REFUND_PENDING" && order.totalMinor === payment.amountMinor ? payment.amountMinor : 0;
  }
  if (!receivedMerchandise(orderCase) || (payment.status !== "COLLECTED" && payment.status !== "PAID")) return 0;
  // Stored line totals already include discounts. Apply the item's share of tax and exclude delivery.
  const merchandiseMinor = returnLines.reduce((total, line) => total +
    Math.floor(line.orderItem.lineTotalMinor * line.quantity / line.orderItem.quantity), 0);
  const orderMerchandiseMinor = order.subtotalMinor - order.discountMinor;
  const taxMinor = orderMerchandiseMinor > 0 ? Number(BigInt(order.taxMinor) * BigInt(merchandiseMinor) / BigInt(orderMerchandiseMinor)) : 0;
  const prior = await db.orderCase.aggregate({ where: { orderId: order.id, id: { not: orderCase.id },
    OR: [{ refundConfirmedAt: { not: null } }, { status: { in: ["REFUND_APPROVED", "REFUND_FAILED"] } }],
  }, _sum: { refundAmountMinor: true } });
  const remaining = Math.min(payment.amountMinor, order.totalMinor) - (prior._sum.refundAmountMinor ?? 0);
  return Math.max(0, Math.min(merchandiseMinor + taxMinor, remaining));
}

export async function staffOrderCase(actorId: string, caseId: string, marketId?: MarketId) {
  const db = getDb();
  const { marketIds } = await authorize(db, actorId, true);
  if (marketId && !marketIds.includes(marketId)) return null;
  const orderCase = await db.orderCase.findFirst({ where: { id: caseId, order: { marketId: marketId ?? { in: marketIds } } }, select: {
    ...detailFields, ...refundFields, refundReference: true, returnDisposition: true,
    order: { select: { ...detailFields.order.select, ...refundFields.order.select } },
    returnLines: { ...detailFields.returnLines, select: { ...detailFields.returnLines.select, orderItem: { select: {
      ...returnLineItem, ...refundFields.returnLines.select.orderItem.select,
    } } } },
  } });
  if (!orderCase) return null;
  const limit = orderCase.refundConfirmedAt ? 0 : await refundLimit(db, orderCase);
  const maxRefundMinor = orderCase.refundAmountMinor === null ? limit : Math.min(limit, orderCase.refundAmountMinor);
  const canApproveCancellation = orderCase.kind === "CANCEL" && pendingCancellationStatuses.some(status => status === orderCase.status) &&
    mayRequestBangladeshCancellation(orderCase.order);
  return { ...orderCase, maxRefundMinor, ...refundActions(orderCase, limit), canApproveCancellation,
    cancellationRefundMinor: canApproveCancellation ? paidBangladeshCancellationAmount(orderCase.order) : 0,
    canShipExchange: orderCase.kind === "EXCHANGE" && orderCase.status === "RETURN_RECEIVED" && receivedMerchandise(orderCase),
  };
}

function ownerCaseTransaction<T>(actor: CaseActor, caseId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return getDb().$transaction(async tx => {
    await authorize(tx, actor.id, true, actor.market);
    const found = await tx.orderCase.findFirst({ where: { id: caseId, order: { marketId: actor.market } },
      select: { orderId: true, order: { select: { marketId: true } } } });
    if (!found) throw new OrderCaseError("Case not found.", 404);
    await authorize(tx, actor.id, true, found.order.marketId);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${found.orderId}::uuid FOR UPDATE`;
    return work(tx);
  });
}

async function progressRefund(actor: CaseActor, command: RefundCommand) {
  return ownerCaseTransaction(actor, command.caseId, async tx => {
    const orderCase = await tx.orderCase.findUnique({ where: { id: command.caseId }, select: refundFields });
    if (!orderCase) throw new OrderCaseError("Case not found.", 404);
    if (command.action === "confirm-refund" && orderCase.refundConfirmedAt && orderCase.refundAmountMinor === command.amountMinor &&
        orderCase.refundMethod === command.method && orderCase.refundReference === command.reference) return { id: orderCase.id };
    if (orderCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    const limit = await refundLimit(tx, orderCase);
    const actions = refundActions(orderCase, limit);
    const approved = orderCase.refundAmountMinor;
    const action = command.action;
    const allowed = action === "approve-refund" ? actions.canApproveRefund
      : action === "confirm-refund" ? command.confirmed === true && actions.canConfirmRefund
        : actions.canConfirmRefund && orderCase.status === "REFUND_APPROVED";
    if (!allowed) throw new OrderCaseError("This refund action is unavailable for the current case status.", 409);
    if ("amountMinor" in command && (command.amountMinor < 1 || !Number.isInteger(command.amountMinor) || command.amountMinor > limit)) {
      throw new OrderCaseError("The refund exceeds the amount paid for these items.", 409);
    }
    if ("amountMinor" in command && approved !== null && command.amountMinor !== approved) {
      throw new OrderCaseError("Use the approved refund amount for this case.", 409);
    }
    const status = action === "approve-refund" ? "REFUND_APPROVED"
      : action === "fail-refund" ? "REFUND_FAILED"
        : orderCase.status === "REFUND_APPROVED" ? "RESOLVED" : orderCase.status;
    const revision = orderCase.revision + 1;
    const fields = action === "confirm-refund" ? {
      refundAmountMinor: command.amountMinor, refundMethod: command.method,
      refundReference: command.reference, refundConfirmedAt: new Date(),
    } : action === "approve-refund" ? { refundAmountMinor: command.amountMinor } : {};
    const result = await tx.orderCase.updateMany({ where: { id: orderCase.id, revision: orderCase.revision }, data: {
      revision, status, ...fields,
    } });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    if (action === "confirm-refund" && orderCase.kind === "CANCEL") {
      const payment = await tx.payment.updateMany({ where: { orderId: orderCase.order.id, status: "REFUND_PENDING" },
        data: { status: "REFUNDED" } });
      if (payment.count !== 1) throw new OrderCaseError("The order payment changed. Refresh the page and try again.", 409);
    }
    await tx.orderCaseEvent.create({ data: { caseId: orderCase.id, status, revision, actorId: actor.id,
      refundConfirmed: action === "confirm-refund", ...("note" in command && { note: command.note }),
    } });
    const audit = action === "confirm-refund" ? "BD_CASE_REFUND_CONFIRMED" : action === "approve-refund" ? "BD_CASE_REFUND_APPROVED" : "BD_CASE_REFUND_FAILED";
    await tx.auditEvent.create({ data: { actorId: actor.id, action: audit, target: orderCase.id, changes: {
      orderId: orderCase.order.id, marketId: "bd", amountMinor: "amountMinor" in command ? command.amountMinor : approved, currency: "BDT",
    } } });
    return { id: orderCase.id };
  });
}

export function buyerCasePhoto(shopperId: string, caseId: string, marketId: MarketId) {
  return getDb().orderCaseAttachment.findFirst({ where: { caseId, orderCase: { order: { shopperId, marketId } } }, select: { data: true } });
}

export async function staffCasePhoto(staffId: string, caseId: string, marketId: MarketId) {
  const db = getDb();
  await authorize(db, staffId, true, marketId);
  return db.orderCaseAttachment.findFirst({ where: { caseId, orderCase: { order: { marketId } } }, select: { data: true } });
}

const queuePageSize = 30;
export async function listOrderCases(actorId: string, includeClosed: boolean, page: number, marketId?: MarketId) {
  const db = getDb();
  const { marketIds } = await authorize(db, actorId, true, marketId);
  const rows = await db.orderCase.findMany({
    where: { order: { marketId: marketId ?? { in: marketIds } }, ...(!includeClosed && { status: { in: [...activeCaseStatuses] } }) },
    orderBy: recentFirst,
    skip: (page - 1) * queuePageSize,
    take: queuePageSize + 1,
    select: { ...summaryFields, order: { select: orderReference } },
  });
  return { rows: rows.slice(0, queuePageSize), hasNext: rows.length > queuePageSize };
}

async function exchangeSelections(db: DbReader, lines: readonly {
  orderItem: ExchangeSource;
  quantity: number;
  replacementVariantId?: string | null;
}[]) {
  if (!lines.length) throw new OrderCaseError("Choose the item and replacement size or color for this exchange.", 400);
  const options = await eligibleExchangeVariants(db, lines.map(line => line.orderItem));
  const choices = lines.map(line => {
    const replacement = options.get(line.orderItem.id)?.find(option => option.id === line.replacementVariantId);
    if (!replacement) throw new OrderCaseError("A selected replacement size or color is no longer eligible for exchange.", 409);
    return { ...line, replacement };
  });
  const quantities = variantQuantities(choices.map(line => ({ variantId: line.replacement.id, quantity: line.quantity })));
  if (choices.some(({ replacement }) => (quantities.get(replacement.id) ?? 0) > replacement.available)) {
    throw new OrderCaseError("There isn’t enough stock for the selected replacements.", 409);
  }
  return { choices, quantities };
}

async function approveCancellation(actor: CaseActor, command: CancellationCommand) {
  return ownerCaseTransaction(actor, command.caseId, async tx => {
    const orderCase = await tx.orderCase.findUnique({ where: { id: command.caseId }, select: {
      id: true, kind: true, status: true, revision: true, order: { select: { ...cancellationOrder,
        items: { select: { variantId: true, quantity: true } } } },
    } });
    if (!orderCase) throw new OrderCaseError("Case not found.", 404);
    const order = orderCase.order;
    if (orderCase.kind !== "CANCEL") throw new OrderCaseError("Only a cancellation request can cancel this order.", 409);
    if (order.status === "CANCELLED" && (["REFUND_APPROVED", "REFUND_FAILED", "RESOLVED"] as const).some(status => status === orderCase.status)) {
      return { id: orderCase.id };
    }
    if (orderCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    if (!pendingCancellationStatuses.some(status => status === orderCase.status) || !mayRequestBangladeshCancellation(order)) {
      throw new OrderCaseError("Only an unshipped Bangladesh order with a verified payment or unpaid COD can be cancelled.", 409);
    }
    const refundAmount = paidBangladeshCancellationAmount(order);
    await cancelLockedUnshippedOrder(tx, order, { actorId: actor.id, paymentStatus: refundAmount > 0 ? "REFUND_PENDING" : "VOIDED" });
    const status = refundAmount > 0 ? "REFUND_APPROVED" : "RESOLVED";
    const revision = command.revision + 1;
    const result = await tx.orderCase.updateMany({ where: { id: orderCase.id, revision: command.revision }, data: {
      status, revision, ...(refundAmount > 0 && { refundAmountMinor: refundAmount }),
    } });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    await tx.orderCaseEvent.create({ data: { caseId: orderCase.id, status, revision, actorId: actor.id, note: command.note } });
    if (refundAmount > 0) {
      await tx.auditEvent.create({ data: { actorId: actor.id, action: "BD_CASE_REFUND_APPROVED", target: orderCase.id, changes: {
        orderId: order.id, marketId: "bd", amountMinor: refundAmount, currency: "BDT",
      } } });
    }
    return { id: orderCase.id };
  });
}

async function openOrderCase(actor: CaseActor, command: OpenCommand, photo?: Uint8Array<ArrayBuffer>) {
  return getDb().$transaction(async tx => {
    const actorId = actor.id;
    const { orderId, kind, note, lines, reason, issueItemId } = command;
    const marketScope = actor.market ? Prisma.sql`AND "marketId" = ${actor.market}::"MarketCode"` : Prisma.empty;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid AND "shopperId" = ${actorId} ${marketScope} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: orderId, shopperId: actorId, marketId: actor.market },
      select: { ...cancellationOrder, returnTerms: true, items: { select: { ...exchangeSource, quantity: true } } },
    });
    if (!order) throw new OrderCaseError("Order not found.", 404);
    const options = purchaseCaseOptions(order);
    const merchandise = merchandiseKinds.some(merchandiseKind => merchandiseKind === kind);
    if (kind === "RETURN") {
      if (options.returnRequest === "support") {
        throw new OrderCaseError("Contact support to discuss a return for this order.", 409);
      }
      if (!mayRequestReturn(order)) throw new OrderCaseError("A return can be requested after delivery.", 409);
    }
    if (kind === "EXCHANGE" && !mayRequestExchange(order)) {
      throw new OrderCaseError("An exchange can only be requested for an eligible delivered Bangladesh order.", 409);
    }
    if (kind === "CANCEL") {
      if (order.marketId === "bd" && order.status === "CANCELLED") {
        const completed = await tx.orderCase.findFirst({ where: { orderId, kind, status: { in: ["RESOLVED", "REFUND_APPROVED", "REFUND_FAILED"] } },
          orderBy: recentFirst, select: { id: true } });
        if (completed) return completed;
      }
      if (!options.onlineCancellation || !(order.marketId === "bd" ? mayRequestBangladeshCancellation(order) : mayRequestCancellation(order))) {
        throw new OrderCaseError("This order can no longer be cancelled online. Ask support for help.", 409);
      }
    }
    if (issueItemId && (kind !== "DISPUTE" || !order.items.some(item => item.id === issueItemId))) {
      throw new OrderCaseError("Choose an item from this order.", 400);
    }
    const existingCase = await tx.orderCase.findFirst({
      where: { orderId, kind: merchandise ? { in: [...merchandiseKinds] } : kind, status: { in: [...activeCaseStatuses] } }, select: { id: true },
    });
    if (existingCase) {
      if (kind === "CANCEL") return existingCase;
      throw new OrderCaseError("An active request already exists for this order.", 409);
    }
    let selectedLines: Prisma.OrderCaseReturnLineCreateManyOrderCaseInput[] | undefined;
    if (options.returnRequest === "item" && merchandise) {
      if (!lines?.length) throw new OrderCaseError("Choose the item and quantity for this request.", 400);
      if (await completedUnitemizedReturn(tx, orderId)) {
        throw new OrderCaseError("Contact GriipBuddy about this order’s previous return before opening another request.", 409);
      }
      if (kind === "RETURN" && lines.some(line => line.replacementVariantId !== undefined)) {
        throw new OrderCaseError("Choose an exchange to request a replacement.", 400);
      }
      const eligible = new Map(order.items.map(item => [item.id, item]));
      const received = await receivedQuantities(tx, orderId);
      const selected = lines.map(line => {
        const orderItem = eligible.get(line.orderItemId);
        if (!orderItem || line.quantity > orderItem.quantity - (received.get(line.orderItemId) ?? 0)) {
          throw new OrderCaseError("One of the selected quantities is no longer available to return.", 409);
        }
        return { ...line, orderItem };
      });
      selectedLines = kind === "EXCHANGE"
        ? (await exchangeSelections(tx, selected)).choices.map(({ orderItem, quantity, replacement }) => ({
          orderItemId: orderItem.id, quantity, replacementVariantId: replacement.id, replacementVariantName: replacement.label,
        }))
        : lines.map(({ orderItemId, quantity }) => ({ orderItemId, quantity }));
    } else if (lines) {
      throw new OrderCaseError("This request does not accept item selection.", 400);
    }
    const immediate = kind === "CANCEL" && mayCancelBangladeshOrderImmediately(order);
    if (immediate) await cancelLockedUnshippedOrder(tx, order, { shopperId: actorId });
    return tx.orderCase.create({
      data: { orderId, kind, reason, issueItemId,
        ...(immediate && { status: "RESOLVED", revision: 1 }),
        events: { create: [{ status: "OPEN", note, revision: 0, shopperActorId: actorId },
          ...(immediate ? [{ status: "RESOLVED" as const, revision: 1, shopperActorId: actorId }] : [])] },
        ...(photo && { attachment: { create: { data: photo } } }),
        ...(selectedLines && { returnLines: { createMany: { data: selectedLines } } }) },
      select: { id: true },
    });
  });
}

async function updateOrderCase(actor: CaseActor, command: UpdateCommand) {
  return getDb().$transaction(async tx => {
    if (actor.role === "owner") await authorize(tx, actor.id, true, actor.market);
    const where = { id: command.caseId, order: { ...(actor.role === "shopper" && { shopperId: actor.id }), marketId: actor.market } };
    const existingCase = await tx.orderCase.findFirst({
      where, select: { id: true, kind: true, status: true, revision: true, order: { select: { status: true, marketId: true } },
        _count: { select: { returnLines: true } } },
    });
    if (!existingCase) throw new OrderCaseError("Case not found.", 404);
    if (actor.role === "owner") await authorize(tx, actor.id, true, existingCase.order.marketId);
    if (existingCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    const allowed = command.action === "withdraw" ? mayWithdrawCase(existingCase.status)
      : command.action === "reply" || command.action === "respond" ? activeCaseStatuses.some(status => status === existingCase.status)
        : ownerCaseTransitions(existingCase.kind, existingCase.status, existingCase._count.returnLines > 0).includes(command.status);
    if (!allowed) throw new OrderCaseError("That action is unavailable for the current case status.", 409);
    if (command.action === "review" && existingCase.kind === "CANCEL" && command.status === "RESOLVED" &&
        existingCase.order.status !== "CANCELLED") {
      throw new OrderCaseError("Cancel the order from its staff page before resolving this request.", 409);
    }
    const status = command.action === "withdraw" ? "WITHDRAWN" : command.action === "review" ? command.status : existingCase.status;
    const revision = command.revision + 1;
    const result = await tx.orderCase.updateMany({ where: { ...where, revision: command.revision }, data: { status, revision } });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    await tx.orderCaseEvent.create({
      data: { caseId: existingCase.id, status, revision, ...(actor.role === "owner" ? { actorId: actor.id } : { shopperActorId: actor.id }),
        ...(command.action !== "withdraw" && { note: command.note }) },
    });
    return { id: existingCase.id };
  });
}

async function receiveOrderCase(actor: CaseActor, command: ReceiveCommand) {
  if (command.confirmed !== true) throw new OrderCaseError("Confirm receipt of the physical items first.", 400);
  return ownerCaseTransaction(actor, command.caseId, async tx => {
    const actorId = actor.id;
    const orderCase = await tx.orderCase.findUnique({
      where: { id: command.caseId },
      select: {
        id: true, kind: true, status: true, revision: true, returnReceivedAt: true,
        order: { select: { id: true, status: true, fulfillmentStatus: true, marketId: true } },
        returnLines: { select: { orderItemId: true, quantity: true, orderItem: { select: {
          orderId: true, quantity: true, variantId: true,
        } } } },
      },
    });
    if (!orderCase) throw new OrderCaseError("Case not found.", 404);
    if (orderCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    if (!merchandiseKinds.some(kind => kind === orderCase.kind) || orderCase.status !== "RETURN_APPROVED" || orderCase.returnReceivedAt ||
        orderCase.order.marketId !== "bd" || !mayRequestReturn(orderCase.order) || !orderCase.returnLines.length) {
      throw new OrderCaseError("Only an approved return or exchange for a delivered Bangladesh order can be received.", 409);
    }
    const received = await receivedQuantities(tx, orderCase.order.id);
    const lines = orderCase.returnLines;
    if (lines.some(line => line.orderItem.orderId !== orderCase.order.id ||
        line.quantity > line.orderItem.quantity - (received.get(line.orderItemId) ?? 0))) {
      throw new OrderCaseError("Returned quantities no longer match the order. No receipt or stock change was saved.", 409);
    }

    const status = "RETURN_RECEIVED";
    const revision = command.revision + 1;
    const result = await tx.orderCase.updateMany({
      where: { id: orderCase.id, revision: command.revision },
      data: { status, revision, returnReceivedAt: new Date(), returnReceivedById: actorId, returnDisposition: command.disposition },
    });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    let restockedUnits = 0;
    if (command.disposition === "RESTOCK") {
      try {
        restockedUnits = await restoreBangladeshInventory(tx,
          lines.map(line => ({ variantId: line.orderItem.variantId, quantity: line.quantity })));
      } catch (error) {
        if (error instanceof OperationError) throw new OrderCaseError(error.message, 409);
        throw error;
      }
    }
    await tx.orderCaseEvent.create({ data: { caseId: orderCase.id, status, revision, actorId } });
    await tx.auditEvent.create({
      data: { actorId, action: "BD_RETURN_CASE_RECEIVED", target: orderCase.id, changes: {
        orderId: orderCase.order.id, marketId: "bd", disposition: command.disposition, restockedUnits,
      } },
    });
    return { id: orderCase.id };
  });
}

async function shipExchange(actor: CaseActor, command: ExchangeCommand) {
  return ownerCaseTransaction(actor, command.caseId, async tx => {
    const orderCase = await tx.orderCase.findUnique({ where: { id: command.caseId }, select: {
      id: true, status: true, kind: true, revision: true, returnReceivedAt: true, replacementCarrier: true, replacementTrackingReference: true,
      order: { select: { id: true, status: true, fulfillmentStatus: true, returnTerms: true, marketId: true } },
      returnLines: { select: { quantity: true, replacementVariantId: true, replacementVariantName: true,
        orderItem: { select: { ...exchangeSource, orderId: true } } } },
    } });
    if (!orderCase) throw new OrderCaseError("Case not found.", 404);
    if (orderCase.kind === "EXCHANGE" && orderCase.replacementCarrier === command.carrier &&
        orderCase.replacementTrackingReference === command.trackingReference) return { id: orderCase.id };
    if (orderCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    if (orderCase.kind !== "EXCHANGE" || orderCase.status !== "RETURN_RECEIVED" || !orderCase.returnReceivedAt ||
        !mayRequestExchange(orderCase.order) || !orderCase.returnLines.length ||
        orderCase.returnLines.some(line => line.orderItem.orderId !== orderCase.order.id)) {
      throw new OrderCaseError("Receive the original items before dispatching their replacements.", 409);
    }
    const variants = await tx.variant.findMany({
      where: { id: { in: orderCase.returnLines.map(line => line.orderItem.variantId) } }, select: { productId: true },
    });
    for (const productId of [...new Set(variants.map(variant => variant.productId))].sort()) await lockProductEdits(tx, productId);
    const { choices, quantities } = await exchangeSelections(tx, orderCase.returnLines);
    if (choices.some((choice, index) => choice.replacement.label !== orderCase.returnLines[index].replacementVariantName)) {
      throw new OrderCaseError("A selected replacement has changed since the request. Confirm the next step with the shopper.", 409);
    }
    const stock = [...quantities].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    for (const [variantId, quantity] of stock) {
      const result = await tx.inventory.updateMany({ where: { variantId, available: { gte: quantity } }, data: { available: { decrement: quantity } } });
      if (result.count !== 1) throw new OrderCaseError("A replacement just sold out. No shipment or stock change was saved.", 409);
    }
    const status = "EXCHANGE_SHIPPED";
    const revision = command.revision + 1;
    const result = await tx.orderCase.updateMany({ where: { id: orderCase.id, revision: command.revision }, data: {
      status, revision, replacementCarrier: command.carrier, replacementTrackingReference: command.trackingReference,
    } });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    await tx.orderCaseEvent.create({ data: { caseId: orderCase.id, status, revision, actorId: actor.id, note: command.note } });
    await tx.auditEvent.create({
      data: { actorId: actor.id, action: "BD_EXCHANGE_SHIPPED", target: orderCase.id, changes: {
        orderId: orderCase.order.id, marketId: "bd", carrier: command.carrier, trackingReference: command.trackingReference,
        replacements: stock.map(([variantId, quantity]) => ({ variantId, quantity })),
      } },
    });
    return { id: orderCase.id };
  });
}

export function executeOrderCase(actor: CaseActor, command: CaseCommand, photo?: Uint8Array<ArrayBuffer>) {
  if (actor.role !== caseActorRole(command.action)) throw new OrderCaseError("You don’t have permission for that action.", 403);
  if (command.action === "open") return openOrderCase(actor, command, photo);
  if (command.action === "receive") return receiveOrderCase(actor, command);
  if (command.action === "approve-cancellation") return approveCancellation(actor, command);
  if (command.action === "approve-refund" || command.action === "confirm-refund" || command.action === "fail-refund") return progressRefund(actor, command);
  if (command.action === "ship-exchange") return shipExchange(actor, command);
  return updateOrderCase(actor, command);
}
