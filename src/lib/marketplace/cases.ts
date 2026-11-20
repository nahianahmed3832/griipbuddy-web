import { createHash } from "node:crypto";
import type { AuditAction, OrderCaseKind, OrderCaseStatus, Prisma } from "../../generated/prisma/client.ts";
import { variantQuantities } from "../cart/model.ts";
import { restoreBangladeshInventory } from "../commerce/bangladesh-returns.ts";
import { CommerceError } from "../commerce/errors.ts";
import { reserveCheckoutStock } from "../commerce/location-inventory.ts";
import { cancelPlannedOrderItems, lockConnectedOrderAttempt, restockInspectedOrderLines } from "../commerce/order-inventory.ts";
import { lockVariantQuoteRows } from "../commerce/orders.ts";
import { setFulfillment } from "../commerce/order-parcels.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { authorize, authorizeOrderOperation, cancelUnshippedOrder, OperationError } from "../staff/operations.ts";
import { activeCaseStatuses, caseActorRole, mayRequestCancellation, mayRequestReturn, mayWithdrawCase, ownerCaseTransitions, type CaseCommand } from "./case-policy.ts";
import { eligibleExchangeVariants } from "./case-shopper.ts";
import { orderHasAdapter } from "../commerce/market-commerce.ts";
import { paypalSandboxConfig } from "../commerce/paypal-config.ts";
import type { MarketId } from "../../config/markets.ts";
import { marketConfiguration } from "../market-config.ts";
import { localMarketTime } from "../market-calendar.ts";
import { itemizedAmount, refundableItemAmount, remainingRefundBalance } from "./case-money.ts";
import { processOrderCaseRefund } from "./case-refunds.ts";

import { OrderCaseError } from "./case-error.ts";
export { OrderCaseError } from "./case-error.ts";

type CaseActor = { role: "shopper" | "owner"; id: string };
type OpenCommand = Extract<CaseCommand, { action: "open" }>;
type UpdateCommand = Extract<CaseCommand, { action: "withdraw" | "review" }>;
type WorkflowCommand = Exclude<CaseCommand, OpenCommand | UpdateCommand | { action: "process-refund" }>;

const summaryFields = { id: true, kind: true, status: true, updatedAt: true } satisfies Prisma.OrderCaseSelect;
const orderReference = { id: true, reference: true, marketId: true } satisfies Prisma.OrderSelect;
const recentFirst = [{ updatedAt: "desc" }, { id: "desc" }] satisfies Prisma.OrderCaseOrderByWithRelationInput[];
const returnLineItem = { id: true, productName: true, variantName: true, sku: true, optionsSnapshot: true,
  personalization: true } satisfies Prisma.OrderItemSelect;
const merchandiseKinds: OrderCaseKind[] = ["RETURN", "EXCHANGE"];
const orderCasePayment = { select: { method: true, status: true, amountMinor: true, currency: true } } satisfies Prisma.Order$paymentArgs;
const operationsOrder = {
  ...orderReference, currency: true, measurementTest: true, commercialSnapshot: true, status: true, fulfillmentStatus: true,
  subtotalMinor: true, discountMinor: true, taxMinor: true, totalMinor: true, payment: orderCasePayment,
} satisfies Prisma.OrderSelect;
type OperationsOrder = Prisma.OrderGetPayload<{ select: typeof operationsOrder }>;
type CancellationOrder = Pick<OperationsOrder, "marketId" | "currency" | "measurementTest" | "commercialSnapshot" |
  "status" | "fulfillmentStatus" | "totalMinor" | "payment">;
export type OrderCaseSummary = Prisma.OrderCaseGetPayload<{ select: typeof summaryFields }>;

function shopperCaseWhere(orderId: string, shopperId: string): Prisma.OrderCaseWhereInput {
  return { orderId, order: { shopperId } };
}

export function casesForPurchase(orderId: string, shopperId: string) {
  return getDb().orderCase.findMany({
    where: shopperCaseWhere(orderId, shopperId), orderBy: recentFirst, take: 20, select: summaryFields,
  });
}

export function caseOpenReceipt(orderId: string, shopperId: string, requestId: string) {
  return getDb().orderCase.findFirst({ where: { ...shopperCaseWhere(orderId, shopperId), openRequestId: requestId }, select: { id: true } });
}

async function caseQuantities(db: DbReader, orderId: string, includePending = false) {
  const rows = await db.orderCaseReturnLine.groupBy({
    by: ["orderItemId"],
    where: { orderCase: { orderId,
      OR: [{ returnReceivedAt: { not: null } }, ...(includePending ? [{
        kind: { in: merchandiseKinds }, status: { in: [...activeCaseStatuses] },
      }] : [])],
    } },
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

const eligibilityOrder = {
  ...operationsOrder,
  items: { select: { ...returnLineItem, quantity: true, variantId: true, marketplaceShopId: true, offerIdSnapshot: true, taxAllocatedMinor: true },
    orderBy: [{ sku: "asc" }, { id: "asc" }] },
  parcels: { select: { status: true, cancelledAt: true, items: { select: { orderItemId: true, quantity: true, cancelledQuantity: true } } } },
  inventoryReservation: { select: { orderId: true, state: true } },
} as const satisfies Prisma.OrderSelect;
type EligibilityOrder = Prisma.OrderGetPayload<{ select: typeof eligibilityOrder }>;

function parcelQuantities(order: EligibilityOrder, status: "PLANNED" | "DELIVERED") {
  const quantity = new Map<string, number>();
  for (const parcel of order.parcels) {
    if (parcel.status !== status || parcel.cancelledAt) continue;
    for (const item of parcel.items) {
      quantity.set(item.orderItemId, (quantity.get(item.orderItemId) ?? 0) + item.quantity - item.cancelledQuantity);
    }
  }
  return quantity;
}

function deliveredItemQuantities(order: EligibilityOrder) {
  if (order.status !== "PLACED") return new Map<string, number>();
  if (order.parcels.length) return parcelQuantities(order, "DELIVERED");
  return new Map(order.items.map(line => [line.id, mayRequestReturn(order) ? line.quantity : 0]));
}

function mayItemizeCancellation(order: EligibilityOrder) {
  if (order.status !== "PLACED" || order.payment?.currency !== order.currency || order.inventoryReservation?.state !== "COMMITTED") return false;
  return order.payment.method === "COD" ? order.payment.status === "AWAITING_COLLECTION" : order.payment.status === "PAID";
}

function cancellationQuantities(order: EligibilityOrder) {
  if (!mayItemizeCancellation(order)) return new Map<string, number>();
  return parcelQuantities(order, "PLANNED");
}

export async function cancellationItemsForPurchase(orderId: string, shopperId: string) {
  const order = await getDb().order.findFirst({ where: { id: orderId, shopperId }, select: eligibilityOrder });
  if (!order) return [];
  const quantities = cancellationQuantities(order);
  return order.items.filter(line => line.offerIdSnapshot && line.taxAllocatedMinor !== null)
    .map(line => ({ ...line, quantity: quantities.get(line.id) ?? 0 })).filter(line => line.quantity > 0);
}

export async function returnItemsForPurchase(orderId: string, shopperId: string) {
  const db = getDb();
  const order = await db.order.findFirst({ where: { id: orderId, shopperId }, select: eligibilityOrder });
  if (!order || !orderHasAdapter(order, "returns", "manual")) return [];
  if (await completedUnitemizedReturn(db, orderId)) return [];
  const delivered = deliveredItemQuantities(order);
  const received = await caseQuantities(db, orderId, true);
  return order.items.map(item => ({ ...item, quantity: (delivered.get(item.id) ?? 0) - (received.get(item.id) ?? 0) }))
    .filter(item => item.quantity > 0);
}

export async function casesForStaffOrder(actorId: string, orderId: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  return db.orderCase.findMany({ where: { orderId }, orderBy: recentFirst, take: 20, select: summaryFields });
}

const detailFields = {
  ...summaryFields,
  revision: true,
  order: { select: orderReference },
  pickupAt: true, pickupReference: true, refundAmountMinor: true, replacementTrackingReference: true, cancellationAppliedAt: true,
  refund: { select: { state: true, amountMinor: true, currency: true, method: true } },
  returnLines: { select: { quantity: true, replacementVariantName: true, orderItem: { select: returnLineItem } }, orderBy: { orderItemId: "asc" } },
  events: {
    orderBy: { revision: "asc" },
    select: { status: true, note: true, publicNote: true, revision: true, createdAt: true },
  },
} satisfies Prisma.OrderCaseSelect;
export type OrderCaseDetail = Prisma.OrderCaseGetPayload<{ select: typeof detailFields }>;

export async function buyerOrderCase(shopperId: string, orderId: string, caseId: string): Promise<OrderCaseDetail | null> {
  const row = await getDb().orderCase.findFirst({ where: { id: caseId, ...shopperCaseWhere(orderId, shopperId) }, select: detailFields });
  return row && { ...row, events: row.events.map(event => ({
    ...event, note: event.status === "OPEN" ? event.note : event.publicNote,
  })) };
}

export async function staffOrderCase(actorId: string, caseId: string, marketId?: MarketId) {
  const db = getDb();
  await authorize(db, actorId, true);
  const orderCase = await db.orderCase.findUnique({ where: { id: caseId, ...(marketId && { order: { marketId } }) }, select: {
    ...detailFields, order: { select: operationsOrder }, returnDisposition: true,
    returnLines: { ...detailFields.returnLines, select: { ...detailFields.returnLines.select,
      settlementUnitOffset: true,
      orderItem: { select: { ...returnLineItem, quantity: true, lineTotalMinor: true, taxAllocatedMinor: true, unitPriceMinor: true, variantId: true } },
    } },
  } });
  if (!orderCase) return null;
  const reviewingCancellation = orderCase.kind === "CANCEL" && orderCase.status === "IN_REVIEW";
  const itemized = orderCase.returnLines.length > 0;
  const requiresCancellationRefund = reviewingCancellation && !itemized && mayOpenCancellationCase(orderCase.order) && paidCancellationAmount(orderCase.order) > 0;
  let eligibleItemized = false;
  if (reviewingCancellation && itemized) {
    const source = await db.order.findUnique({ where: { id: orderCase.order.id }, select: eligibilityOrder });
    if (source) {
      const selected = orderCase.returnLines.map(line => ({ orderItemId: line.orderItem.id, quantity: line.quantity }));
      try { requireCancellableLines(source, selected); eligibleItemized = true; }
      catch (error) { if (!(error instanceof OrderCaseError)) throw error; }
    }
  }
  const canApproveCancellation = reviewingCancellation && (eligibleItemized || !itemized && orderCase.order.payment?.method === "COD" &&
    orderCase.order.payment.status === "AWAITING_COLLECTION" && mayOpenCancellationCase(orderCase.order));
  const refundLimitMinor = requiresCancellationRefund ? paidCancellationAmount(orderCase.order)
    : (merchandiseKinds.includes(orderCase.kind) && orderCase.status === "RETURN_RECEIVED" && orderHasAdapter(orderCase.order, "returns", "manual") ||
        orderCase.kind === "CANCEL" && orderCase.status === "CANCELLATION_APPROVED")
      ? await refundableItemAmount(db, orderCase.order, orderCase.returnLines) : 0;
  const paypal = paypalSandboxConfig(orderCase.order.marketId);
  const bound = orderCase.refund?.method === "PAYPAL" && paypal?.accountKey && paypal.clientId && paypal.clientSecret &&
    orderCase.order.measurementTest === true && (orderCase.refund.state === "AUTHORIZED" || orderCase.refund.state === "PROCESSING")
      ? await db.payPalCheckout.findFirst({ where: { attempt: { order: { id: orderCase.order.id } }, providerAccountKey: paypal.accountKey,
        captureId: { not: null }, refundStartedAt: null }, select: { attemptId: true } }) : null;
  const exact = orderCase.returnLines.length ? itemizedAmount(orderCase.returnLines) : orderCase.kind === "CANCEL" ? orderCase.order.totalMinor : null;
  const canProcessRefund = Boolean(bound && orderCase.refund && exact !== null && exact >= orderCase.refund.amountMinor);
  return { ...orderCase, requiresCancellationRefund, canApproveCancellation, refundLimitMinor, canProcessRefund };
}

const queuePageSize = 30;
export async function listOrderCases(actorId: string, includeClosed: boolean, page: number, marketId?: MarketId) {
  const db = getDb();
  await authorize(db, actorId, true);
  const rows = await db.orderCase.findMany({
    where: { ...(!includeClosed && { status: { in: [...activeCaseStatuses] } }), ...(marketId && { order: { marketId } }) },
    orderBy: recentFirst,
    skip: (page - 1) * queuePageSize,
    take: queuePageSize + 1,
    select: { ...summaryFields, order: { select: orderReference } },
  });
  return { rows: rows.slice(0, queuePageSize), hasNext: rows.length > queuePageSize };
}

function paidCancellationAmount(order: CancellationOrder) {
  const payment = order.payment;
  return payment && (payment.method === "SSLCOMMERZ" || payment.method === "PAYPAL") && payment.status === "PAID" && payment.currency === order.currency &&
    payment.amountMinor === order.totalMinor ? payment.amountMinor : 0;
}

export function mayOpenCancellationCase(order: CancellationOrder) {
  return mayRequestCancellation(order) && (paidCancellationAmount(order) > 0 ||
    (order.payment?.method === "COD" && order.payment.status === "AWAITING_COLLECTION" && order.payment.currency === order.currency));
}

async function settledUnits(db: DbReader, orderId: string) {
  const rows = await db.orderCaseReturnLine.groupBy({
    by: ["orderItemId"], where: { orderCase: { orderId,
      OR: [{ returnReceivedAt: { not: null } }, { cancellationAppliedAt: { not: null } }],
    } }, _sum: { quantity: true },
  });
  return new Map(rows.map(line => [line.orderItemId, line._sum.quantity ?? 0]));
}

async function reserveSettlementSlices(tx: Prisma.TransactionClient, orderCase: WorkflowCase) {
  const alreadySettled = await settledUnits(tx, orderCase.order.id);
  const slices = orderCase.returnLines.map(line => ({ ...line, settlementUnitOffset: alreadySettled.get(line.orderItemId) ?? 0 }));
  if (slices.some(line => line.settlementUnitOffset + line.quantity > line.orderItem.quantity)) {
    throw new OrderCaseError("The case quantities exceed the original purchased line.", 409);
  }
  for (const { orderItemId, settlementUnitOffset } of slices) {
    await tx.orderCaseReturnLine.update({ where: { caseId_orderItemId: { caseId: orderCase.id, orderItemId } }, data: { settlementUnitOffset } });
  }
  return slices;
}

type ExchangeSource = Parameters<typeof eligibleExchangeVariants>[1][number];
type ExchangeLine = {
  orderItem: ExchangeSource;
  quantity: number;
  replacementVariantId?: string | null;
  replacementVariantName?: string | null;
};

async function exchangeSelections(db: DbReader, lines: ExchangeLine[], marketId: MarketId) {
  if (!lines.length) throw new OrderCaseError("Choose the items and replacement sizes or colors for this exchange.", 400);
  const options = await eligibleExchangeVariants(db, lines.map(line => line.orderItem), marketId);
  const choices = lines.map(line => {
    const replacement = options.get(line.orderItem.id)?.find(option => option.id === line.replacementVariantId);
    if (!replacement) throw new OrderCaseError("A selected replacement size or color is no longer available for exchange.", 409);
    return { ...line, replacement };
  });
  const quantities = variantQuantities(choices.map(line => ({ variantId: line.replacement.id, quantity: line.quantity })));
  if (choices.some(({ replacement }) => (quantities.get(replacement.id) ?? 0) > replacement.available)) {
    throw new OrderCaseError("There isn’t enough stock for the selected replacements.", 409);
  }
  return choices;
}

async function openOrderCase(actorId: string, command: OpenCommand) {
  return getDb().$transaction(async tx => {
    const { orderId, kind, note, lines, requestId } = command;
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid AND "shopperId" = ${actorId} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: orderId, shopperId: actorId },
      select: eligibilityOrder,
    });
    if (!order) throw new OrderCaseError("Order not found.", 404);
    const requestDigest = requestId && createHash("sha256").update(JSON.stringify({ actorId, kind, note,
      lines: lines?.slice().sort((left, right) => left.orderItemId.localeCompare(right.orderItemId)) ?? [],
    })).digest("hex");
    if (requestId) {
      const receipt = await tx.orderCase.findUnique({ where: { orderId_openRequestId: { orderId, openRequestId: requestId } },
        select: { id: true, openRequestDigest: true } });
      if (receipt) {
        if (receipt.openRequestDigest !== requestDigest) throw new OrderCaseError("This request was already submitted with different details. Check the previous submission.", 409);
        return { id: receipt.id };
      }
    }
    const delivered = deliveredItemQuantities(order);
    if (merchandiseKinds.includes(kind) && ![...delivered.values()].some(quantity => quantity > 0)) {
      throw new OrderCaseError("A return or exchange can be requested after delivery.", 409);
    }
    if (kind === "CANCEL" && !lines?.length && !mayOpenCancellationCase(order)) {
      throw new OrderCaseError("Only an eligible order that hasn’t shipped can be cancelled.", 409);
    }
    const existingCase = await tx.orderCase.findFirst({
      where: { orderId, kind, status: { in: [...activeCaseStatuses] } }, select: { id: true },
    });
    if (existingCase) throw new OrderCaseError("An active case of this type already exists for this order.", 409);
    let caseLines: Prisma.OrderCaseReturnLineCreateManyOrderCaseInput[] | undefined;
    if (kind === "RETURN" || kind === "EXCHANGE") {
      if (!orderHasAdapter(order, "returns", "manual")) throw new OrderCaseError("Contact support for the configured return workflow for this order.", 409);
      if (!lines?.length) throw new OrderCaseError("Choose the items and quantities for this request.", 400);
      if (kind === "RETURN" && lines.some(line => line.replacementVariantId !== undefined)) {
        throw new OrderCaseError("Choose an exchange to request a replacement.", 400);
      }
      if (kind === "EXCHANGE" && lines.some(line => !line.replacementVariantId)) {
        throw new OrderCaseError("Choose a replacement size or color for each selected item.", 400);
      }
      if (await completedUnitemizedReturn(tx, orderId)) {
        throw new OrderCaseError("Contact GriipBuddy about this order’s previous return before opening another request.", 409);
      }
      const eligible = new Map(order.items.map(item => [item.id, item]));
      const committed = await caseQuantities(tx, orderId, true);
      const selected = lines.map(line => {
        const orderItem = eligible.get(line.orderItemId);
        if (!orderItem || line.quantity > (delivered.get(line.orderItemId) ?? 0) - (committed.get(line.orderItemId) ?? 0)) {
          throw new OrderCaseError("One of the selected quantities is no longer available to return or exchange.", 409);
        }
        return { ...line, orderItem };
      });
      caseLines = kind === "EXCHANGE"
        ? (await exchangeSelections(tx, selected, order.marketId)).map(({ orderItem, quantity, replacement }) => ({
          orderItemId: orderItem.id, quantity, replacementVariantId: replacement.id, replacementVariantName: replacement.label,
        })) : selected.map(({ orderItemId, quantity }) => ({ orderItemId, quantity }));
    } else if (kind === "CANCEL" && lines?.length) {
      requireCancellableLines(order, lines);
      caseLines = lines.map(({ orderItemId, quantity }) => ({ orderItemId, quantity }));
    } else if (lines) {
      throw new OrderCaseError("Item selection is only used for a cancellation, return, or exchange.", 400);
    }
    return tx.orderCase.create({
      data: { orderId, kind, events: { create: { status: "OPEN", note, revision: 0 } },
        ...(requestId && { openRequestId: requestId, openRequestDigest: requestDigest }),
        ...(caseLines && { returnLines: { createMany: { data: caseLines } } }) },
      select: { id: true },
    });
  });
}

function requireCancellableLines(order: EligibilityOrder, lines: NonNullable<OpenCommand["lines"]>) {
  const quantities = cancellationQuantities(order);
  if (lines.some(line => line.replacementVariantId !== undefined || line.quantity > (quantities.get(line.orderItemId) ?? 0) ||
      !order.items.some(item => item.id === line.orderItemId && item.offerIdSnapshot && item.taxAllocatedMinor !== null))) {
    throw new OrderCaseError("Choose quantities in planned parcels with complete order-time pricing and inventory allocations.", 409);
  }
  const remaining = order.parcels.flatMap(parcel => parcel.items).reduce((sum, line) => sum + line.quantity - line.cancelledQuantity, 0);
  if (lines.reduce((sum, line) => sum + line.quantity, 0) >= remaining) {
    throw new OrderCaseError("Use whole-order cancellation for all remaining items before dispatch.", 409);
  }
}

async function updateOrderCase(actor: CaseActor, command: UpdateCommand) {
  return getDb().$transaction(async tx => {
    if (actor.role === "owner") await authorize(tx, actor.id, true);
    const where = { id: command.caseId, ...(actor.role === "shopper" && { order: { shopperId: actor.id } }) };
    const existingCase = await tx.orderCase.findFirst({
      where, select: { id: true, kind: true, status: true, revision: true, order: { select: { marketId: true } }, refund: { select: { state: true } }, _count: { select: { returnLines: true } } },
    });
    if (!existingCase) throw new OrderCaseError("Case not found.", 404);
    if (actor.role === "owner") await authorizeOrderOperation(tx, actor.id, existingCase.order.marketId, true);
    if (existingCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    const allowed = command.action === "withdraw"
      ? mayWithdrawCase(existingCase.status)
      : ownerCaseTransitions(existingCase.kind, existingCase.status, existingCase._count.returnLines > 0).includes(command.status);
    if (!allowed) throw new OrderCaseError("That action is unavailable for the current case status.", 409);
    if (command.action === "review" && command.status === "RESOLVED" && existingCase.status === "REFUND_APPROVED" &&
        existingCase.refund?.state !== "CONFIRMED") {
      throw new OrderCaseError("Resolve this case after the original payment refund has been confirmed.", 409);
    }
    const status = command.action === "withdraw" ? "WITHDRAWN" : command.status;
    const revision = command.revision + 1;
    const result = await tx.orderCase.updateMany({ where: { ...where, revision: command.revision }, data: { status, revision } });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    await tx.orderCaseEvent.create({
      data: { caseId: existingCase.id, status, revision, ...(command.action === "review" && { note: command.note, publicNote: command.publicNote, actorId: actor.id }) },
    });
    return { id: existingCase.id };
  });
}

const workflowFields = {
  id: true, kind: true, status: true, revision: true, returnReceivedAt: true,
  order: { select: eligibilityOrder },
  returnLines: { select: { orderItemId: true, quantity: true, settlementUnitOffset: true, replacementVariantId: true, replacementVariantName: true, orderItem: { select: {
    id: true, orderId: true, quantity: true, variantId: true, offerIdSnapshot: true,
    personalization: true, marketplaceShopId: true, lineTotalMinor: true, taxAllocatedMinor: true,
  } } } },
} satisfies Prisma.OrderCaseSelect;

type WorkflowCase = Prisma.OrderCaseGetPayload<{ select: typeof workflowFields }>;
type WorkflowUpdate = {
  status: OrderCaseStatus;
  fields?: Prisma.OrderCaseUncheckedUpdateManyInput;
  audit: { action: AuditAction; changes: Prisma.InputJsonObject };
};

async function receiveItems(tx: Prisma.TransactionClient, orderCase: WorkflowCase, actorId: string,
    command: Extract<WorkflowCommand, { action: "receive" }>, connectedAttempt: string | null): Promise<WorkflowUpdate> {
  if (command.confirmed !== true) throw new OrderCaseError("Confirm receipt of the physical items first.", 400);
  if (!merchandiseKinds.includes(orderCase.kind) || !["RETURN_APPROVED", "PICKUP_SCHEDULED"].includes(orderCase.status) ||
      orderCase.returnReceivedAt || !orderCase.returnLines.length) {
    throw new OrderCaseError("Only an approved item return or exchange for a delivered order can be received.", 409);
  }
  const received = await caseQuantities(tx, orderCase.order.id);
  const lines = orderCase.returnLines;
  const delivered = deliveredItemQuantities(orderCase.order);
  if (lines.some(line => line.orderItem.orderId !== orderCase.order.id ||
      line.quantity > (delivered.get(line.orderItemId) ?? 0) - (received.get(line.orderItemId) ?? 0))) {
    throw new OrderCaseError("Returned quantities no longer match the order. No receipt or stock change was saved.", 409);
  }
  await reserveSettlementSlices(tx, orderCase);
  const fields = { returnReceivedAt: new Date(), returnReceivedById: actorId, returnDisposition: command.disposition };
  const receipt = lines.map(line => ({
    id: line.orderItemId, variantId: line.orderItem.variantId, offerIdSnapshot: line.orderItem.offerIdSnapshot,
    quantity: line.quantity, receivedBefore: received.get(line.orderItemId),
  }));
  let restockedUnits = 0;
  if (command.disposition === "RESTOCK") {
    if (connectedAttempt) {
      // The inventory service requires a saved inspection. This provisional update rolls back with any failed movement.
      await tx.orderCase.update({ where: { id: orderCase.id }, data: fields });
      restockedUnits = await restockInspectedOrderLines(tx, actorId, connectedAttempt, orderCase.id, receipt);
    } else {
      restockedUnits = await restoreBangladeshInventory(tx, receipt);
    }
  }
  return {
    status: "RETURN_RECEIVED",
    fields,
    audit: { action: "BD_RETURN_CASE_RECEIVED", changes: { disposition: command.disposition, restockedUnits } },
  };
}

async function shipReplacements(tx: Prisma.TransactionClient, orderCase: WorkflowCase,
    command: Extract<WorkflowCommand, { action: "ship-exchange" }>): Promise<WorkflowUpdate> {
  if (orderCase.kind !== "EXCHANGE" || orderCase.status !== "RETURN_RECEIVED" || !orderCase.returnReceivedAt || !mayRequestReturn(orderCase.order)) {
    throw new OrderCaseError("Inspect the original items before shipping their replacements.", 409);
  }
  const lines = orderCase.returnLines;
  const variantIds = lines.flatMap(line => line.replacementVariantId ? [line.orderItem.variantId, line.replacementVariantId] : []);
  const { marketId } = orderCase.order;
  if (variantIds.length) await lockVariantQuoteRows(tx, marketId, variantIds);
  const choices = await exchangeSelections(tx, lines, marketId);
  if (choices.some(choice => choice.replacement.label !== choice.replacementVariantName)) {
    throw new OrderCaseError("A selected replacement has changed since the request. Confirm the next step with the shopper.", 409);
  }
  const allocations = await reserveCheckoutStock(tx, marketId, choices.map(line => ({ variantId: line.replacement.id, quantity: line.quantity })))
    .catch(error => {
      if (error instanceof CommerceError) throw new OrderCaseError("The replacement just sold out. No shipment or stock change was saved.", 409);
      throw error;
    });
  if (new Set(allocations.map(line => line.locationId)).size > 1) {
    throw new OrderCaseError("These replacements need multiple dispatch locations. This exchange can record one parcel. Review the replacement or refund with the shopper.", 409);
  }
  return {
    status: "EXCHANGE_SHIPPED", fields: { replacementTrackingReference: command.trackingReference },
    audit: { action: "BD_EXCHANGE_SHIPPED", changes: {
      trackingReference: command.trackingReference, replacements: allocations.map(({ variantId, locationId, quantity }) => ({ variantId, locationId, quantity })),
    } },
  };
}

async function applyWorkflow(tx: Prisma.TransactionClient, orderCase: WorkflowCase, actorId: string,
    command: WorkflowCommand, connectedAttempt: string | null): Promise<WorkflowUpdate> {
  const { order } = orderCase;
  if (command.action === "receive") return receiveItems(tx, orderCase, actorId, command, connectedAttempt);
  if (command.action === "ship-exchange") return shipReplacements(tx, orderCase, command);
  if (command.action === "schedule-pickup") {
    const deliverable = deliveredItemQuantities(order);
    if (!merchandiseKinds.includes(orderCase.kind) || !["RETURN_APPROVED", "PICKUP_SCHEDULED"].includes(orderCase.status) ||
        !orderCase.returnLines.length || !orderCase.returnLines.every(line => (deliverable.get(line.orderItemId) ?? 0) >= line.quantity)) {
      throw new OrderCaseError("Approve the item return or exchange before scheduling pickup.", 409);
    }
    const pickupAt = command.pickupAt.endsWith("Z") ? new Date(command.pickupAt)
      : localMarketTime(command.pickupAt, marketConfiguration(order.marketId).timeZone);
    if (!pickupAt || !Number.isFinite(pickupAt.getTime()) || pickupAt.getTime() <= Date.now()) {
      throw new OrderCaseError("Choose an unambiguous pickup time in the future for the order market.", 400);
    }
    return { status: "PICKUP_SCHEDULED", fields: { pickupAt, pickupReference: command.pickupReference },
      audit: { action: "BD_CASE_PICKUP_SCHEDULED", changes: { pickupAt: pickupAt.toISOString(), pickupReference: command.pickupReference } } };
  }
  const reviewingCancellation = orderCase.kind === "CANCEL" && orderCase.status === "IN_REVIEW";
  if (command.action === "approve-cancellation") {
    if (!reviewingCancellation) throw new OrderCaseError("Review this cancellation request first.", 409);
    if (orderCase.returnLines.length) {
      if (!connectedAttempt) throw new OrderCaseError("This purchase needs a connected parcel allocation.", 409);
      requireCancellableLines(order, orderCase.returnLines.map(({ orderItemId, quantity }) => ({ orderItemId, quantity })));
      const slices = await reserveSettlementSlices(tx, orderCase);
      const adjustment = itemizedAmount(slices);
      if (adjustment === null || !order.payment) throw new OrderCaseError("This purchase requires exact order-time pricing.", 409);
      const changes = await cancelPlannedOrderItems(tx, actorId, order.id, connectedAttempt, orderCase.returnLines);
      const activeParcels = await tx.orderParcel.findMany({ where: { orderId: order.id, cancelledAt: null }, select: { status: true } });
      if (order.fulfillmentStatus !== "DELIVERED" && activeParcels.length && activeParcels.every(parcel => parcel.status === "DELIVERED")) {
        await setFulfillment(tx, order.id, actorId, "DELIVERED");
      }
      const cod = order.payment.method === "COD" && order.payment.status === "AWAITING_COLLECTION";
      if (cod) {
        if (adjustment >= order.payment.amountMinor) throw new OrderCaseError("Review the remaining collectible balance before cancelling.", 409);
        await tx.payment.update({ where: { orderId: order.id }, data: { amountMinor: { decrement: adjustment } } });
      }
      return { status: cod || adjustment === 0 ? "RESOLVED" : "CANCELLATION_APPROVED",
        fields: { cancellationAppliedAt: new Date() },
        audit: { action: "BD_CASE_CANCELLATION_APPROVED", changes: {
          allocations: changes, itemAmountMinor: adjustment, currency: order.currency, ...(cod && { collectibleMinor: order.payment.amountMinor - adjustment }),
        } } };
    }
    if (!mayOpenCancellationCase(order) || order.payment?.method !== "COD" || order.payment.status !== "AWAITING_COLLECTION") {
      throw new OrderCaseError("Only an unshipped COD order awaiting collection can be cancelled this way.", 409);
    }
    await cancelUnshippedOrder(tx, actorId, order.id, { caseId: orderCase.id });
    return { status: "RESOLVED", fields: { cancellationAppliedAt: new Date() },
      audit: { action: "BD_CASE_CANCELLATION_APPROVED", changes: {} } };
  }
  const amount = command.amountMinor;
  if (!Number.isInteger(amount) || amount < 1 || !order.payment) throw new OrderCaseError("Enter a valid refund amount.", 400);
  if (order.payment.method === "PAYPAL" && await tx.payPalCheckout.findFirst({
    where: { attempt: { order: { id: order.id } }, refundStartedAt: { not: null } }, select: { attemptId: true },
  })) throw new OrderCaseError("Reconcile the existing order refund before authorizing another payment effect.", 409);
  if (reviewingCancellation && !orderCase.returnLines.length) {
    if (paidCancellationAmount(order) !== amount || await remainingRefundBalance(tx, order) < amount) {
      throw new OrderCaseError("A prepaid cancellation requires approval for the full eligible payment amount.", 409);
    }
    await cancelUnshippedOrder(tx, actorId, order.id, { caseId: orderCase.id, refundAmountMinor: amount });
  } else {
    const inspected = merchandiseKinds.includes(orderCase.kind) && orderCase.status === "RETURN_RECEIVED" && orderCase.returnReceivedAt;
    if (!inspected && (orderCase.kind !== "CANCEL" || orderCase.status !== "CANCELLATION_APPROVED")) {
      throw new OrderCaseError("Inspect the returned items or cancel the selected parcels before approving a refund.", 409);
    }
    const limit = await refundableItemAmount(tx, order, orderCase.returnLines);
    if (amount > limit) throw new OrderCaseError("The refund exceeds the amount paid for these items.", 409);
  }
  await tx.orderCaseRefund.create({ data: { caseId: orderCase.id, method: order.payment.method, currency: order.currency, amountMinor: amount } });
  return {
    status: "REFUND_APPROVED", fields: { refundAmountMinor: amount, ...(reviewingCancellation && { cancellationAppliedAt: new Date() }) },
    audit: { action: "BD_CASE_REFUND_APPROVED", changes: { amountMinor: amount, currency: order.currency } },
  };
}

async function runOwnerWorkflow(actorId: string, command: WorkflowCommand) {
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    const found = await tx.orderCase.findUnique({ where: { id: command.caseId }, select: { orderId: true } });
    if (!found) throw new OrderCaseError("Case not found.", 404);
    const connectedAttempt = await lockConnectedOrderAttempt(tx, found.orderId);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${found.orderId}::uuid FOR UPDATE`;
    const orderCase = await tx.orderCase.findUnique({ where: { id: command.caseId }, select: workflowFields });
    if (!orderCase) throw new OrderCaseError("Case not found.", 404);
    await authorizeOrderOperation(tx, actorId, orderCase.order.marketId, true);
    if (orderCase.revision !== command.revision) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    if (merchandiseKinds.includes(orderCase.kind) && !orderHasAdapter(orderCase.order, "returns", "manual")) {
      throw new OrderCaseError("This order requires its configured returns adapter.", 409);
    }
    let update: WorkflowUpdate;
    try {
      update = await applyWorkflow(tx, orderCase, actorId, command, connectedAttempt);
    } catch (error) {
      if (error instanceof OperationError) throw new OrderCaseError(error.message, 409);
      throw error;
    }
    const revision = command.revision + 1;
    const result = await tx.orderCase.updateMany({
      where: { id: orderCase.id, revision: command.revision },
      data: { ...update.fields, status: update.status, revision },
    });
    if (result.count !== 1) throw new OrderCaseError("This case changed. Refresh the page and try again.", 409);
    await tx.orderCaseEvent.create({
      data: { caseId: orderCase.id, status: update.status, revision, actorId, ...("note" in command && { note: command.note }) },
    });
    await tx.auditEvent.create({
      data: { actorId, action: update.audit.action, target: orderCase.id,
        changes: { ...update.audit.changes, orderId: orderCase.order.id, marketId: orderCase.order.marketId } },
    });
    return { id: orderCase.id };
  });
}

export function executeOrderCase(actor: CaseActor, command: CaseCommand) {
  if (actor.role !== caseActorRole(command)) throw new OrderCaseError("You don’t have permission for that action.", 403);
  if (command.action === "open") return openOrderCase(actor.id, command);
  if (command.action === "review" || command.action === "withdraw") return updateOrderCase(actor, command);
  if (command.action === "process-refund") return processOrderCaseRefund(actor.id, command);
  return runOwnerWorkflow(actor.id, command);
}
