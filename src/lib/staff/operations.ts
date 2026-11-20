import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { validVariantId } from "../cart/model.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { canCancelFrom, nextFulfillment } from "../commerce/labels.ts";
import { orderDetails } from "../commerce/orders.ts";
import { bangladeshStaffTrackingHistory, demoHandoff, devShipmentAvailable } from "../commerce/bangladesh-shipment.ts";
import { nextBangladeshTrackingStatuses } from "../commerce/bangladesh-shipment-status.ts";
import { hasInventoryCommitment, lockVariantInventory } from "../commerce/location-inventory.ts";
import { lockConnectedOrderAttempt, releaseUnshippedOrderStock } from "../commerce/order-inventory.ts";
import { staffParcelHistory } from "../commerce/parcel-tracking.ts";
import { hybridStoreMode } from "../release-config.ts";
import { orderHasAdapter } from "../commerce/market-commerce.ts";
import { CatalogWriteError, OperationError } from "./operation-error.ts";

export { OperationError } from "./operation-error.ts";

function deny(): never {
  throw new CatalogWriteError("forbidden", "You don’t have permission for that action.");
}

export async function authorize(db: DbReader, actorId: string, ownerOnly = false) {
  const staff = await db.staffAccess.findUnique({ where: { userId: actorId } });
  if (!staff?.active || (ownerOnly && staff.role !== "OWNER")) deny();
  return staff;
}

export async function operationsScope(db: DbReader, actorId: string, ownerOnly = false): Promise<Prisma.OrderWhereInput> {
  const { role } = await authorize(db, actorId, ownerOnly);
  if (role === "OWNER") return {};
  const grants = await db.staffMarketAccess.findMany({ where: { userId: actorId, operations: true }, select: { marketId: true } });
  return { marketId: { in: grants.map(grant => grant.marketId) } };
}

export async function authorizeOrderOperation(tx: Prisma.TransactionClient, actorId: string, marketId: MarketId, ownerOnly = false) {
  // Hold the active staff and relevant grant rows through the order mutation.
  await tx.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actorId} FOR SHARE`;
  const { role } = await authorize(tx, actorId, ownerOnly);
  if (role === "OWNER") return;
  const [grant] = await tx.$queryRaw<{ operations: boolean }[]>`
    SELECT "operations" FROM "StaffMarketAccess"
    WHERE "userId" = ${actorId} AND "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
  if (!grant?.operations) deny();
}

export async function lockProductEdits(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}), 37)`;
}

export const queueFilters = [
  ["queue", "Packing queue"], ["all", "All orders"], ["UNFULFILLED", "Unfulfilled"],
  ["PACKING", "Packing"], ["READY_TO_SHIP", "Ready to ship"], ["SHIPPED", "Shipped"],
  ["DELIVERED", "Delivered"], ["refused", "Refused parcels"], ["CANCELLED", "Cancelled"],
] as const;
export type QueueFilter = typeof queueFilters[number][0];

export function queueFilter(value: unknown): QueueFilter {
  return queueFilters.find(([id]) => id === value)?.[0] ?? "queue";
}

const pageSize = 30;
const pendingCancellationCase = { kind: "CANCEL", status: { in: ["OPEN", "IN_REVIEW"] } } satisfies Prisma.OrderCaseWhereInput;
const pendingCancellationDetails = { where: pendingCancellationCase, select: { id: true }, take: 1 } as const;

export async function listStaffOrders(actorId: string, filter: QueueFilter, page: number, marketId?: MarketId) {
  const db = getDb();
  const scope = await operationsScope(db, actorId);
  const where: Prisma.OrderWhereInput = filter === "queue"
    ? { status: "PLACED", AND: [
      { OR: [
        { fulfillmentStatus: { in: ["UNFULFILLED", "PACKING", "READY_TO_SHIP"] } },
        { fulfillmentStatus: "SHIPPED", parcels: { some: { status: "PLANNED" } } },
      ] },
      { OR: [{ payment: { method: "COD", status: "AWAITING_COLLECTION" } }, { payment: { status: "PAID" } }] },
    ] }
    : filter === "all" ? {}
      : filter === "CANCELLED" ? { status: "CANCELLED" }
      : filter === "refused" ? { status: "PLACED", OR: [
        { bangladeshShipment: { is: { status: "REFUSED" } } },
        { parcels: { some: { status: { in: ["REFUSED", "RETURNED"] } } } },
      ] }
      : { status: "PLACED", fulfillmentStatus: filter,
        ...(filter === "SHIPPED" && {
          NOT: { bangladeshShipment: { is: { status: "REFUSED" } } },
          OR: [{ parcels: { none: {} } }, { parcels: { some: { status: { in: ["PLANNED", "IN_TRANSIT", "OUT_FOR_DELIVERY"] } } } }],
        }) };
  const rows = await db.order.findMany({
    where: { AND: [where, scope, ...(marketId ? [{ marketId }] : [])] },
    orderBy: [{ createdAt: filter === "queue" ? "asc" : "desc" }, { id: "asc" }],
    skip: (page - 1) * pageSize, take: pageSize + 1,
    select: {
      id: true, reference: true, status: true, fulfillmentStatus: true, districtLabel: true, createdAt: true,
      marketId: true, totalMinor: true, payment: { select: { status: true } }, _count: { select: { items: true } },
      bangladeshShipment: { select: { status: true } },
      bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
      parcels: { select: { status: true } },
      cases: pendingCancellationDetails,
    },
  });
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

export async function staffOrder(actorId: string, id: string, marketId?: MarketId) {
  const db = getDb();
  const scope = await operationsScope(db, actorId);
  if (!uuid.safeParse(id).success) return null;
  return db.order.findFirst({
    where: { AND: [{ id, marketId }, scope] }, include: {
      ...orderDetails,
      bangladeshShipment: bangladeshStaffTrackingHistory,
      bangladeshRefusedParcelReceipt: { select: { receivedAt: true, disposition: true, restockedUnits: true, note: true } },
      parcels: staffParcelHistory,
      cases: pendingCancellationDetails,
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { actor: { select: { name: true } } } },
    },
  });
}

async function lockedOrder(tx: Prisma.TransactionClient, id: string, scope: Prisma.OrderWhereInput = {}) {
  if (!uuid.safeParse(id).success) throw new OperationError("Order not found.");
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const order = await tx.order.findFirst({ where: { AND: [{ id }, scope] }, include: orderDetails });
  if (!order?.payment) throw new OperationError("Order not found.");
  return { ...order, payment: order.payment };
}

function pendingCancellation(tx: Prisma.TransactionClient, orderId: string) {
  return tx.orderCase.findFirst({
    where: { orderId, ...pendingCancellationCase },
    select: { id: true },
  });
}

const shipmentText = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\u0000-\u001f\u007f]+$/u);
const shipment = z.object({ carrier: shipmentText(60), trackingReference: shipmentText(80) });
const fulfillmentInput = z.object({
  next: z.enum(["PACKING", "READY_TO_SHIP", "SHIPPED", "DELIVERED"]),
  carrier: z.string().optional(), trackingReference: z.string().optional(),
  simulate: z.boolean().optional(),
});

export async function advanceFulfillment(actorId: string, orderId: string, input: unknown) {
  const parsed = fulfillmentInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Choose a valid fulfillment step.");
  const { next } = parsed.data;
  await getDb().$transaction(async (tx) => {
    const order = await lockedOrder(tx, orderId, await operationsScope(tx, actorId));
    await authorizeOrderOperation(tx, actorId, order.marketId);
    if (order.status !== "PLACED") throw new OperationError("This order is cancelled.");
    if (order.payment.method !== "COD" && order.payment.status !== "PAID") {
      throw new OperationError("This prepaid order cannot move through packing while payment is incomplete or a refund is pending.");
    }
    if ((next === "SHIPPED" || next === "DELIVERED") && (await hasInventoryCommitment(tx, orderId) ||
        await tx.orderParcel.findFirst({ where: { orderId }, select: { id: true } }))) {
      throw new OperationError("Use the parcel controls to dispatch and update this order.");
    }
    if (nextFulfillment[order.fulfillmentStatus] !== next) throw new OperationError("That step is no longer available. Refresh the order and try again.");
    if (next === "SHIPPED" && await pendingCancellation(tx, orderId)) {
      throw new OperationError("Review the shopper’s pending cancellation before shipping this order.");
    }
    if (next === "DELIVERED" && await tx.bangladeshShipment.findUnique({ where: { orderId }, select: { orderId: true } })) {
      throw new OperationError("Record the courier’s delivery outcome in shipment tracking.");
    }
    const simulate = parsed.data.simulate === true;
    if (simulate && (next !== "SHIPPED" || !devShipmentAvailable(order))) throw new OperationError("The demo courier is available only for test orders.");
    const tracking = shipment.safeParse(simulate ? demoHandoff() : parsed.data);
    if (next === "SHIPPED" && !tracking.success) throw new OperationError("Enter a carrier and a tracking reference before shipping.");
    const fields = next === "SHIPPED" && tracking.success ? tracking.data : {};
    await tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus: next, ...fields } });
    if (next === "SHIPPED" && tracking.success && hybridStoreMode() && orderHasAdapter(order, "fulfillment", "steadfast")) {
      await tx.bangladeshShipment.create({
        data: {
          orderId, ...tracking.data, status: "IN_TRANSIT", source: simulate ? "DEV_SIMULATOR" : "MANUAL",
          events: { create: { actorId, status: "IN_TRANSIT" } },
        },
      });
    }
    await tx.fulfillmentEvent.create({
      data: { orderId, actorId, status: next, type: "STATUS_CHANGED" },
    });
    await tx.auditEvent.create({
      data: { actorId, action: "FULFILLMENT_CHANGED", target: orderId, changes: { from: order.fulfillmentStatus, to: next, ...fields } },
    });
  });
}

const trackingInput = z.object({
  status: z.enum(["OUT_FOR_DELIVERY", "DELIVERED", "REFUSED"]),
  evidence: shipmentText(200).min(3).optional(),
});

export async function recordBangladeshTracking(actorId: string, orderId: string, input: unknown) {
  const parsed = trackingInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Choose a courier status and enter a valid evidence reference if required.");
  const { status, evidence } = parsed.data;
  await getDb().$transaction(async (tx) => {
    const order = await lockedOrder(tx, orderId, await operationsScope(tx, actorId, status === "REFUSED"));
    await authorizeOrderOperation(tx, actorId, order.marketId, status === "REFUSED");
    const current = await tx.bangladeshShipment.findUnique({ where: { orderId } });
    if (!current || order.status !== "PLACED") throw new OperationError("There is no active courier shipment for this order.");
    const simulated = current.source === "DEV_SIMULATOR";
    if (simulated && !devShipmentAvailable(order)) throw new OperationError("The demo courier is available only for test orders.");
    if (current.status === status) return;
    if (order.fulfillmentStatus !== "SHIPPED" || !nextBangladeshTrackingStatuses(current.status).includes(status)) {
      throw new OperationError("That shipment status is no longer available. Refresh the order and try again.");
    }
    if (!simulated && !evidence) throw new OperationError("Enter the courier’s event or support reference.");
    if (status === "REFUSED" && order.payment.method === "COD" && order.payment.status !== "AWAITING_COLLECTION") {
      throw new OperationError("A refusal can only void an outstanding COD payment.");
    }
    const recordedAt = new Date();
    await tx.bangladeshShipment.update({ where: { orderId }, data: { status, statusUpdatedAt: recordedAt } });
    await tx.bangladeshShipmentEvent.create({ data: { orderId, status, actorId, recordedAt, evidence: simulated ? null : evidence } });
    if (status === "DELIVERED") {
      await tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus: "DELIVERED" } });
      await tx.fulfillmentEvent.create({ data: { orderId, actorId, status: "DELIVERED", type: "STATUS_CHANGED" } });
    }
    const voidedCod = status === "REFUSED" && order.payment.method === "COD";
    if (voidedCod) await tx.payment.update({ where: { orderId }, data: { status: "VOIDED" } });
    await tx.auditEvent.create({
      data: { actorId, action: "FULFILLMENT_CHANGED", target: orderId,
        changes: { shipment: { from: current.status, to: status, source: current.source }, ...(voidedCod && { paymentStatus: "VOIDED" }) } },
    });
  });
}

export async function cancelOrder(actorId: string, orderId: string) {
  await getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    await cancelUnshippedOrder(tx, actorId, orderId);
  });
}

// The caller authorizes staff and commits the case transition with the cancellation.
export async function cancelUnshippedOrder(tx: Prisma.TransactionClient, actorId: string, orderId: string,
    approval?: { caseId: string; refundAmountMinor?: number }) {
  if (!uuid.safeParse(orderId).success) throw new OperationError("Order not found.");
  const connectedAttempt = await lockConnectedOrderAttempt(tx, orderId);
  const order = await lockedOrder(tx, orderId);
  if (order.status === "CANCELLED" && !approval) return;
  const paidRefund = approval?.refundAmountMinor;
  const paymentCanBeCancelled = paidRefund === undefined
    ? order.payment.method === "COD" && order.payment.status === "AWAITING_COLLECTION"
    : order.payment.method === "SSLCOMMERZ" && order.payment.status === "PAID" &&
      paidRefund > 0 && paidRefund === order.payment.amountMinor && paidRefund === order.totalMinor;
  if (order.status !== "PLACED" || !canCancelFrom.includes(order.fulfillmentStatus) || !paymentCanBeCancelled) {
    throw new OperationError(paidRefund === undefined ? "Only unshipped orders awaiting collection can be cancelled."
      : "An unshipped prepaid order needs approval for a refund of the full payment.");
  }
  if (await tx.orderParcel.findFirst({ where: { orderId, status: { not: "PLANNED" } }, select: { id: true } })) {
    throw new OperationError("This order has a dispatched parcel and can’t be cancelled before shipment.");
  }
  if (!approval && await pendingCancellation(tx, orderId)) {
    throw new OperationError("Open the shopper’s pending cancellation case to review this order.");
  }
  const paymentStatus = paidRefund === undefined ? "VOIDED" : "REFUND_PENDING";
  await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  await releaseUnshippedOrderStock(tx, actorId, connectedAttempt, order.items);
  await tx.payment.update({ where: { orderId }, data: { status: paymentStatus } });
  await tx.fulfillmentEvent.create({ data: { orderId, actorId, status: order.fulfillmentStatus, type: "ORDER_CANCELLED" } });
  await tx.auditEvent.create({
    data: { actorId, action: "ORDER_CANCELLED", target: orderId,
      changes: { restoredLines: order.items.length, paymentStatus, ...(approval && { cancellationCaseId: approval.caseId }) } },
  });
}

export async function collectCash(actorId: string, orderId: string) {
  await getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    const order = await lockedOrder(tx, orderId);
    if (order.status !== "PLACED" || order.fulfillmentStatus !== "DELIVERED" || order.payment.method !== "COD" ||
        order.currency !== order.payment.currency) {
      throw new OperationError("Record COD collection after the order is delivered.");
    }
    if (await tx.orderParcel.findFirst({ where: { orderId, status: { not: "DELIVERED" } }, select: { id: true } })) {
      throw new OperationError("Record full COD collection only after every parcel is delivered.");
    }
    const shipment = await tx.bangladeshShipment.findUnique({ where: { orderId }, select: { status: true } });
    if (shipment && shipment.status !== "DELIVERED") throw new OperationError("Record COD collection after the courier confirms delivery.");
    if (order.payment.status === "COLLECTED") return;
    if (order.payment.status !== "AWAITING_COLLECTION") throw new OperationError("This payment is unavailable for collection.");
    await tx.payment.update({ where: { orderId }, data: { status: "COLLECTED", collectedAt: new Date(), collectedById: actorId } });
    await tx.auditEvent.create({
      data: { actorId, action: "CASH_COLLECTION_RECORDED", target: orderId, changes: { amountMinor: order.payment.amountMinor, currency: order.payment.currency } },
    });
  });
}

export async function listStaffCatalog(actorId: string, productId?: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  return db.variant.findMany({
    where: productId ? { productId } : undefined,
    take: productId ? 40 : 60,
    orderBy: [{ product: { position: "asc" } }, { position: "asc" }],
    select: {
      id: true, sku: true, label: true, product: { select: { name: true, marketplaceShopId: true } },
      inventory: { select: { available: true } },
      locationInventory: { select: { locationId: true, available: true } },
      offers: { orderBy: { marketId: "asc" }, select: { marketId: true, amountMinor: true } },
    },
  });
}

export const staffStockChangeInput = z.object({
  variantId: z.string().refine(validVariantId),
  delta: z.number().int().min(-10000).max(10000).refine((delta) => delta !== 0),
  reason: z.string().trim().min(3).max(200),
});
const priceChange = z.object({
  variantId: z.string().refine(validVariantId),
  marketId: z.enum(["bd", "us"]),
  amountMinor: z.number().int().min(1).max(15_000_000),
  expectedMinor: z.number().int().min(1).max(15_000_000),
});

export async function adjustStock(actorId: string, input: unknown) {
  const parsed = staffStockChangeInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter a nonzero whole-unit adjustment between −10,000 and 10,000 and explain the reason.");
  const { variantId, delta, reason } = parsed.data;
  await getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    await lockVariantInventory(tx, [variantId]);
    if (await tx.variant.findFirst({ where: { id: variantId, managedInventory: true }, select: { id: true } })) {
      throw new OperationError("Use owner and warehouse inventory for this variant.");
    }
    if (await tx.locationInventory.findFirst({ where: { variantId }, select: { locationId: true } })) {
      throw new OperationError("This variant uses stock by dispatch location. Adjust a location count instead.");
    }
    const rows = await tx.$queryRaw<{ available: number }[]>`
      SELECT "available" FROM "Inventory" WHERE "variantId" = ${variantId} FOR UPDATE
    `;
    const before = rows[0]?.available;
    if (before === undefined) throw new OperationError("No stock record exists for this variant.");
    const available = before + delta;
    if (available < 0 || available > 1_000_000) throw new OperationError("That adjustment would move available stock outside the supported range.");
    await tx.inventory.update({ where: { variantId }, data: { available } });
    await tx.auditEvent.create({
      data: { actorId, action: "STOCK_CHANGED", target: variantId, changes: { before, after: available, delta, reason } },
    });
  });
}

export async function updatePrice(actorId: string, input: unknown) {
  const parsed = priceChange.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter a price between 0.01 and 150,000.00 with up to two decimals.");
  const { variantId, marketId, amountMinor, expectedMinor } = parsed.data;
  await getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: { productId: true } });
    if (!variant) throw new OperationError("This SKU is unavailable.");
    await lockProductEdits(tx, variant.productId);
    const rows = await tx.$queryRaw<{ amountMinor: number; discountMinor: number | null; offerId: string | null }[]>`
      SELECT "amountMinor", "discountMinor", "offerId" FROM "MarketOffer"
      WHERE "variantId" = ${variantId} AND "marketId" = ${marketId}::"MarketCode" FOR UPDATE
    `;
    const offer = rows[0];
    if (!offer) throw new OperationError("That variant is not listed in the selected market.");
    if (offer.offerId) throw new OperationError("Use the market offer editor for this price.");
    if (offer.amountMinor !== expectedMinor) throw new OperationError("This price changed. Refresh before trying again.");
    if (amountMinor <= (offer.discountMinor ?? 0)) throw new OperationError("The price must exceed its configured discount.");
    if (amountMinor === offer.amountMinor) return;
    await tx.marketOffer.update({ where: { variantId_marketId: { variantId, marketId } }, data: { amountMinor } });
    await tx.product.update({ where: { id: variant.productId }, data: { revision: { increment: 1 } } });
    await tx.auditEvent.create({
      data: { actorId, action: "PRICE_CHANGED", target: variantId, changes: { marketId, currency: markets[marketId].currency, before: offer.amountMinor, after: amountMinor } },
    });
  });
}
