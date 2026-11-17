import { Prisma } from "../../generated/prisma/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { restoreBangladeshInventory } from "../commerce/bangladesh-returns.ts";
import { purchaseCaseOptions } from "../commerce/order-return-terms.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { authorize, OperationError } from "../staff/operations.ts";
import { activeCaseStatuses, caseActorRole, mayRequestCancellation, mayRequestReturn, mayWithdrawCase, ownerCaseTransitions, type CaseCommand } from "./case-policy.ts";

export class OrderCaseError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type CaseActor = { role: "shopper" | "owner"; id: string; market?: MarketId };
type OpenCommand = Extract<CaseCommand, { action: "open" }>;
type ReceiveCommand = Extract<CaseCommand, { action: "receive" }>;
type RefundCommand = Extract<CaseCommand, { action: "confirm-refund" }>;
type UpdateCommand = Exclude<CaseCommand, OpenCommand | ReceiveCommand | RefundCommand>;

const summaryFields = { id: true, kind: true, status: true, updatedAt: true, reason: true } satisfies Prisma.OrderCaseSelect;
const orderReference = { id: true, reference: true, marketId: true } satisfies Prisma.OrderSelect;
const recentFirst = [{ updatedAt: "desc" }, { id: "desc" }] satisfies Prisma.OrderCaseOrderByWithRelationInput[];
const returnLineItem = { id: true, productName: true, variantName: true, personalization: true } satisfies Prisma.OrderItemSelect;
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
  refundAmountMinor: true, refundMethod: true, refundConfirmedAt: true,
  returnLines: { select: { quantity: true, orderItem: { select: returnLineItem } }, orderBy: { orderItemId: "asc" } },
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
  order: { select: { id: true, marketId: true, subtotalMinor: true, discountMinor: true, taxMinor: true, totalMinor: true,
    payment: { select: { status: true, amountMinor: true, currency: true } } } },
  returnLines: { select: { quantity: true, orderItem: { select: { quantity: true, lineTotalMinor: true } } } },
} satisfies Prisma.OrderCaseSelect;
type RefundCase = Prisma.OrderCaseGetPayload<{ select: typeof refundFields }>;

function canRecordRefund(orderCase: RefundCase) {
  return orderCase.kind === "RETURN" && (orderCase.status === "RETURN_RECEIVED" || orderCase.status === "RESOLVED") &&
    Boolean(orderCase.returnReceivedAt) && !orderCase.refundConfirmedAt && orderCase.order.marketId === "bd" && orderCase.returnLines.length > 0;
}

async function refundLimit(db: DbReader, orderCase: RefundCase) {
  const { order, returnLines } = orderCase;
  const payment = order.payment;
  if (!payment || payment.currency !== "BDT" || (payment.status !== "COLLECTED" && payment.status !== "PAID")) return 0;
  // Stored line totals already include discounts. Apply the item's share of tax and exclude delivery.
  const merchandiseMinor = returnLines.reduce((total, line) => total +
    Math.floor(line.orderItem.lineTotalMinor * line.quantity / line.orderItem.quantity), 0);
  const orderMerchandiseMinor = order.subtotalMinor - order.discountMinor;
  const taxMinor = orderMerchandiseMinor > 0 ? Number(BigInt(order.taxMinor) * BigInt(merchandiseMinor) / BigInt(orderMerchandiseMinor)) : 0;
  const prior = await db.orderCase.aggregate({ where: { orderId: order.id, refundConfirmedAt: { not: null } }, _sum: { refundAmountMinor: true } });
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
    returnLines: { ...detailFields.returnLines, select: { quantity: true, orderItem: { select: {
      ...returnLineItem, ...refundFields.returnLines.select.orderItem.select,
    } } } },
  } });
  if (!orderCase) return null;
  const maxRefundMinor = canRecordRefund(orderCase) ? await refundLimit(db, orderCase) : 0;
  return { ...orderCase, maxRefundMinor };
}

async function confirmRefund(actor: CaseActor, command: RefundCommand) {
  return getDb().$transaction(async tx => {
    await authorize(tx, actor.id, true, actor.market);
    const found = await tx.orderCase.findFirst({ where: { id: command.caseId, order: { marketId: actor.market } }, select: { orderId: true } });
    if (!found) throw new OrderCaseError("Case not found.", 404);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${found.orderId}::uuid FOR UPDATE`;
    const orderCase = await tx.orderCase.findUnique({ where: { id: command.caseId }, select: refundFields });
    if (!orderCase) throw new OrderCaseError("Case not found.", 404);
    await authorize(tx, actor.id, true, orderCase.order.marketId);
    if (orderCase.refundConfirmedAt && orderCase.refundAmountMinor === command.amountMinor &&
        orderCase.refundMethod === command.method && orderCase.refundReference === command.reference) return { id: orderCase.id };
    if (orderCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    if (command.confirmed !== true || !canRecordRefund(orderCase)) {
      throw new OrderCaseError("Confirm the refund after the returned items are received and the payout is complete.", 409);
    }
    if (command.amountMinor < 1 || !Number.isInteger(command.amountMinor) || command.amountMinor > await refundLimit(tx, orderCase)) {
      throw new OrderCaseError("The refund exceeds the amount paid for these items.", 409);
    }
    const revision = orderCase.revision + 1;
    const result = await tx.orderCase.updateMany({ where: { id: orderCase.id, revision: orderCase.revision }, data: {
      revision, refundAmountMinor: command.amountMinor, refundMethod: command.method,
      refundReference: command.reference, refundConfirmedAt: new Date(),
    } });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    await tx.orderCaseEvent.create({ data: { caseId: orderCase.id, status: orderCase.status, revision, actorId: actor.id, refundConfirmed: true } });
    await tx.auditEvent.create({ data: { actorId: actor.id, action: "BD_CASE_REFUND_CONFIRMED", target: orderCase.id, changes: {
      orderId: orderCase.order.id, marketId: "bd", amountMinor: command.amountMinor, currency: "BDT", outcome: "confirmed",
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

async function openOrderCase(actor: CaseActor, command: OpenCommand, photo?: Uint8Array<ArrayBuffer>) {
  return getDb().$transaction(async tx => {
    const actorId = actor.id;
    const { orderId, kind, note, lines, reason, issueItemId } = command;
    const marketScope = actor.market ? Prisma.sql`AND "marketId" = ${actor.market}::"MarketCode"` : Prisma.empty;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid AND "shopperId" = ${actorId} ${marketScope} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: orderId, shopperId: actorId, marketId: actor.market },
      select: { status: true, fulfillmentStatus: true, marketId: true, returnTerms: true, items: { select: { id: true, quantity: true } } },
    });
    if (!order) throw new OrderCaseError("Order not found.", 404);
    const options = purchaseCaseOptions(order);
    if (kind === "RETURN") {
      if (options.returnRequest === "support") {
        throw new OrderCaseError("Contact support to discuss a return for this order.", 409);
      }
      if (!mayRequestReturn(order)) throw new OrderCaseError("A return can be requested after delivery.", 409);
    }
    if (kind === "CANCEL" && (!options.onlineCancellation || !mayRequestCancellation(order))) {
      throw new OrderCaseError("This order can no longer be cancelled online. Ask support for help.", 409);
    }
    if (issueItemId && (kind !== "DISPUTE" || !order.items.some(item => item.id === issueItemId))) {
      throw new OrderCaseError("Choose an item from this order.", 400);
    }
    const existingCase = await tx.orderCase.findFirst({
      where: { orderId, kind, status: { in: [...activeCaseStatuses] } }, select: { id: true },
    });
    if (existingCase) throw new OrderCaseError("An active case of this type already exists for this order.", 409);
    if (options.returnRequest === "item" && kind === "RETURN") {
      if (!lines?.length) throw new OrderCaseError("Choose the item and quantity you want to return.", 400);
      if (await completedUnitemizedReturn(tx, orderId)) {
        throw new OrderCaseError("Contact GriipBuddy about this order’s previous return before opening another request.", 409);
      }
      const eligible = new Map(order.items.map(item => [item.id, item.quantity]));
      const received = await receivedQuantities(tx, orderId);
      if (lines.some(line => line.quantity > (eligible.get(line.orderItemId) ?? 0) - (received.get(line.orderItemId) ?? 0))) {
        throw new OrderCaseError("One of the selected quantities is no longer available to return.", 409);
      }
    } else if (lines) {
      throw new OrderCaseError("This request does not accept item selection.", 400);
    }
    return tx.orderCase.create({
      data: { orderId, kind, reason, issueItemId, events: { create: { status: "OPEN", note, revision: 0, shopperActorId: actorId } },
        ...(photo && { attachment: { create: { data: photo } } }),
        ...(lines && { returnLines: { createMany: { data: lines } } }) },
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
  return getDb().$transaction(async tx => {
    const actorId = actor.id;
    await authorize(tx, actorId, true, actor.market);
    const found = await tx.orderCase.findFirst({ where: { id: command.caseId, order: { marketId: actor.market } }, select: { orderId: true } });
    if (!found) throw new OrderCaseError("Case not found.", 404);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${found.orderId}::uuid FOR UPDATE`;
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
    await authorize(tx, actorId, true, orderCase.order.marketId);
    if (orderCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    if (orderCase.kind !== "RETURN" || orderCase.status !== "RETURN_APPROVED" || orderCase.returnReceivedAt ||
        orderCase.order.marketId !== "bd" || !mayRequestReturn(orderCase.order) || !orderCase.returnLines.length) {
      throw new OrderCaseError("Only an approved item return for a delivered Bangladesh order can be received.", 409);
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

export function executeOrderCase(actor: CaseActor, command: CaseCommand, photo?: Uint8Array<ArrayBuffer>) {
  if (actor.role !== caseActorRole(command.action)) throw new OrderCaseError("You don’t have permission for that action.", 403);
  if (command.action === "open") return openOrderCase(actor, command, photo);
  if (command.action === "receive") return receiveOrderCase(actor, command);
  if (command.action === "confirm-refund") return confirmRefund(actor, command);
  return updateOrderCase(actor, command);
}
