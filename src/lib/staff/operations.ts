import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { FulfillmentStatus } from "../../generated/prisma/enums.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { validVariantId } from "../cart/model.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { uuid, walletTransaction } from "../commerce/checkout-types.ts";
import { canCancelFrom, nextFulfillment } from "../commerce/labels.ts";
import { orderDetails } from "../commerce/orders.ts";
import { bangladeshStaffTrackingHistory, demoHandoff, devShipmentAvailable } from "../commerce/bangladesh-shipment.ts";
import { nextBangladeshTrackingStatuses } from "../commerce/bangladesh-shipment-status.ts";
import { isManualPaymentMethod } from "../commerce/manual-payment-methods.ts";
import { notifyOrder } from "../commerce/order-notifications.ts";
import { hybridDemoMode, hybridStoreMode } from "../release-config.ts";
import { pendingCancellationStatuses } from "../marketplace/case-policy.ts";
import { storeShop } from "../marketplace/constants.ts";
import { devAdminOrderScope } from "./dev-admin-orders.ts";
import { devAdminWarehouse, type DevAdminFulfillmentOperator } from "./dev-admin-order-proof.ts";
import { warehouseDispatchKey, warehouseVariant } from "./hybrid-warehouse-evidence.ts";
import {
  ensureNoPendingWarehousePosting, postWarehouseMovement, runWarehouseOperation,
  warehouseFingerprint, warehouseInventoryEnabled, warehouseTransactionOptions,
} from "./hybrid-warehouse.ts";

export class OperationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

function deny(): never {
  throw new OperationError("You don’t have permission for that action.", 403);
}

export async function authorize(db: DbReader, actorId: string, ownerOnly = false, marketId?: MarketId) {
  const staff = await db.staffAccess.findUnique({ where: { userId: actorId } });
  if (!staff?.active || (ownerOnly && staff.role !== "OWNER") || (marketId && !staff.marketIds.includes(marketId))) deny();
  return staff;
}

export async function lockProductEdits(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}), 37)`;
}

export const queueFilters = [
  ["queue", "Packing queue"], ["payment-review", "Payment review"], ["all", "All orders"], ["UNFULFILLED", "Unfulfilled"],
  ["PACKING", "Packing"], ["READY_TO_SHIP", "Ready to ship"], ["SHIPPED", "Shipped"],
  ["DELIVERED", "Delivered"], ["refused", "Refused parcels"], ["CANCELLED", "Cancelled"],
] as const;
export type QueueFilter = typeof queueFilters[number][0];

export function queueFilter(value: unknown): QueueFilter {
  return queueFilters.find(([id]) => id === value)?.[0] ?? "queue";
}

const pageSize = 30;
export async function listStaffOrders(actorId: string, filter: QueueFilter, page: number) {
  const db = getDb();
  const scope = await authorize(db, actorId, filter === "payment-review");
  const where: Prisma.OrderWhereInput = filter === "queue"
    ? { status: "PLACED", fulfillmentStatus: { in: ["UNFULFILLED", "PACKING", "READY_TO_SHIP"] },
      OR: [{ payment: { method: "COD" } }, { payment: { status: "PAID" } }] }
    : filter === "payment-review" ? { status: "PLACED", payment: { status: "AWAITING_VERIFICATION" } }
      : filter === "all" ? {}
      : filter === "CANCELLED" ? { status: "CANCELLED" }
      : filter === "refused" ? { status: "PLACED", bangladeshShipment: { is: { status: "REFUSED" } } }
      : { status: "PLACED", fulfillmentStatus: filter,
        ...(filter === "SHIPPED" && { NOT: { bangladeshShipment: { is: { status: "REFUSED" } } } }) };
  const rows = await db.order.findMany({
    where: { ...where, marketId: { in: scope.marketIds } }, orderBy: [{ createdAt: filter === "queue" || filter === "payment-review" ? "asc" : "desc" }, { id: "asc" }],
    skip: (page - 1) * pageSize, take: pageSize + 1,
    select: {
      id: true, reference: true, status: true, fulfillmentStatus: true, districtLabel: true, createdAt: true,
      marketId: true, totalMinor: true, payment: { select: { status: true } }, _count: { select: { items: true } },
      bangladeshShipment: { select: { status: true } },
      bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
    },
  });
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

export async function staffOrder(actorId: string, id: string) {
  const db = getDb();
  const scope = await authorize(db, actorId);
  if (!uuid.safeParse(id).success) return null;
  return db.order.findFirst({
    where: { id, marketId: { in: scope.marketIds } }, include: {
      ...orderDetails,
      bangladeshShipment: bangladeshStaffTrackingHistory,
      bangladeshRefusedParcelReceipt: { select: { receivedAt: true, disposition: true, restockedUnits: true, note: true } },
      events: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: { actor: { select: { name: true } } } },
    },
  });
}

async function lockedOrder(tx: Prisma.TransactionClient, id: string, where: Prisma.OrderWhereInput) {
  if (!uuid.safeParse(id).success) throw new OperationError("Order not found.", 404);
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id}::uuid FOR UPDATE`;
  const order = await tx.order.findFirst({ where: { ...where, id }, include: orderDetails });
  if (!order?.payment) throw new OperationError("Order not found.", 404);
  return { ...order, payment: order.payment };
}

export type FulfillmentActor = string | DevAdminFulfillmentOperator;

export async function lockFulfillmentOrder(tx: Prisma.TransactionClient, actor: FulfillmentActor, orderId: string,
  { ownerOnly = false, returns = false, bangladeshOnly = false }: { ownerOnly?: boolean; returns?: boolean; bangladeshOnly?: boolean } = {}) {
  if (typeof actor === "string") {
    const scope = await authorize(tx, actor, ownerOnly, bangladeshOnly ? "bd" : undefined);
    const order = await lockedOrder(tx, orderId, { marketId: bangladeshOnly ? "bd" : { in: scope.marketIds } });
    return { order, actorId: actor };
  }
  if (process.env.COMMERCE_MODE !== "staging" || !hybridDemoMode() || returns && !actor.canReturn) deny();
  const order = await lockedOrder(tx, orderId, devAdminOrderScope);
  if (actor.assignedWarehouseId && order.shippingWarehouseId && order.shippingWarehouseId !== actor.assignedWarehouseId) {
    throw new OperationError("Order not found.", 404);
  }
  // The service account has no credentials or staff access. It identifies the signed admin actor in audit records.
  const actorId = `editable-admin:${actor.id}`;
  const email = `${actor.id}@editable-admin.invalid`;
  await tx.user.upsert({ where: { id: actorId }, create: { id: actorId, email, name: actor.name }, update: { name: actor.name } });
  return { order, actorId };
}

const shipmentText = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\u0000-\u001f\u007f]+$/u);
const shipment = z.object({ carrier: shipmentText(60), trackingReference: shipmentText(80) });
const fulfillmentInput = z.object({
  next: z.enum(["PACKING", "READY_TO_SHIP", "SHIPPED", "DELIVERED"]),
  carrier: z.string().optional(), trackingReference: z.string().optional(),
  simulate: z.boolean().optional(),
  warehouse: devAdminWarehouse.optional(),
});

export async function advanceFulfillment(actor: FulfillmentActor, orderId: string, input: unknown) {
  const parsed = fulfillmentInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Choose a valid fulfillment step.");
  const { next } = parsed.data;
  const changed = await runWarehouseOperation(complete => getDb().$transaction(async (tx) => {
    const { order, actorId } = await lockFulfillmentOrder(tx, actor, orderId);
    const warehouse = parsed.data.warehouse;
    const simulate = parsed.data.simulate === true;
    const dispatchKey = warehouseDispatchKey(orderId);
    const dispatch = next === "SHIPPED" ? await tx.hybridWarehousePosting.findUnique({ where: { key: dispatchKey },
      select: { fingerprint: true, completedAt: true, trackingReference: true },
    }) : null;
    await ensureNoPendingWarehousePosting(tx, orderId, next === "SHIPPED" ? dispatchKey : undefined);
    const tracking = shipment.safeParse(simulate ? demoHandoff(dispatch?.trackingReference ?? undefined) : parsed.data);
    const fingerprint = warehouseFingerprint([warehouse?.id ?? null, simulate, simulate ? null : tracking.data ?? null]);
    if (dispatch?.completedAt && dispatch.fingerprint === fingerprint) return false;
    if (order.status !== "PLACED") throw new OperationError("This order is cancelled.");
    if (next === "SHIPPED" && order.marketId === "bd" && await tx.orderCase.findFirst({
      where: { orderId, kind: "CANCEL", status: { in: [...pendingCancellationStatuses] } }, select: { id: true },
    })) {
      throw new OperationError("Review the open cancellation request before dispatching this order.");
    }
    if (order.payment.method !== "COD" && order.payment.status !== "PAID") {
      throw new OperationError("This prepaid order cannot move through packing while payment is incomplete or a refund is pending.");
    }
    if (nextFulfillment[order.fulfillmentStatus] !== next) throw new OperationError("That step is no longer available. Refresh the order and try again.");
    if (next === "DELIVERED" && order.marketId === "bd" && await tx.bangladeshShipment.findUnique({ where: { orderId }, select: { orderId: true } })) {
      throw new OperationError("Record the courier’s delivery outcome in Bangladesh shipment tracking.");
    }
    if (simulate && (next !== "SHIPPED" || !devShipmentAvailable(order))) throw new OperationError("The demo courier is available only for test orders.");
    if (next === "SHIPPED" && !tracking.success) throw new OperationError("Enter a carrier and a tracking reference before shipping.");
    if (typeof actor !== "string" && next === "SHIPPED" &&
      (!warehouse || actor.assignedWarehouseId && warehouse.id !== actor.assignedWarehouseId)) {
      throw new OperationError("Choose an available shipping warehouse.");
    }
    if (warehouse && (typeof actor === "string" || next !== "SHIPPED" || order.shippingWarehouseId)) {
      throw new OperationError("Shipping warehouse is recorded once at dispatch.");
    }
    if (next === "SHIPPED" && order.marketId === "bd" && tracking.success) {
      const tracked = order.items.filter(item => warehouseVariant.test(item.variantId) &&
        (item.marketplaceShopId === null || item.marketplaceShopId === storeShop.id));
      if (dispatch || tracked.length && order.measurementTest === true && warehouseInventoryEnabled()) {
        if (typeof actor === "string" || !warehouse) {
          throw new OperationError("Choose the shipping warehouse in editable Orders to record this dispatch.");
        }
        const posted = await postWarehouseMovement(tx, { key: dispatchKey, fingerprint, trackingReference: tracking.data.trackingReference,
          request: { action: "dispatch", orderId, reference: order.reference, warehouseId: warehouse.id, operatorId: actor.id,
            lines: tracked.map(item => ({ itemId: item.id, variantId: item.variantId, sku: item.sku, quantity: item.quantity })) },
        }, complete);
        if (!("evidence" in posted)) return posted;
      }
    }
    const fields = next === "SHIPPED" && tracking.success ? {
      ...tracking.data,
      ...(warehouse && { shippingWarehouseId: warehouse.id, shippingWarehouseName: warehouse.name }),
    } : {};
    await tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus: next, ...fields } });
    if (next === "SHIPPED" && tracking.success && order.marketId === "bd" && hybridStoreMode()) {
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
    return true;
  }, warehouseTransactionOptions));
  if (changed && typeof actor === "string" && next === "SHIPPED") await notifyOrder(orderId, "shipped");
  if (changed && typeof actor === "string" && next === "DELIVERED") await notifyOrder(orderId, "delivered");
}

const trackingInput = z.object({
  status: z.enum(["OUT_FOR_DELIVERY", "DELIVERED", "REFUSED"]),
  evidence: shipmentText(200).min(3).optional(),
});

export async function recordBangladeshTracking(actor: FulfillmentActor, orderId: string, input: unknown) {
  const parsed = trackingInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Choose a courier status and enter a valid evidence reference if required.");
  const { status, evidence } = parsed.data;
  const changed = await getDb().$transaction(async (tx) => {
    const { order, actorId } = await lockFulfillmentOrder(tx, actor, orderId, { ownerOnly: status === "REFUSED", returns: status === "REFUSED" });
    const current = order.marketId === "bd" && await tx.bangladeshShipment.findUnique({ where: { orderId } });
    if (!current || order.status !== "PLACED") throw new OperationError("There is no active Bangladesh shipment for this order.");
    const simulated = current.source === "DEV_SIMULATOR";
    if (simulated && !devShipmentAvailable(order)) throw new OperationError("The demo courier is available only for test orders.");
    if (current.status === status) return false;
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
    return true;
  });
  if (changed && typeof actor === "string") await notifyOrder(orderId, ({ OUT_FOR_DELIVERY: "out-for-delivery", DELIVERED: "delivered", REFUSED: "refused" } as const)[status]);
}

export async function cancelLockedUnshippedOrder(tx: Prisma.TransactionClient, order: {
  id: string;
  fulfillmentStatus: FulfillmentStatus;
  items: readonly { variantId: string; quantity: number }[];
}, { actorId = null, shopperId, paymentStatus = "VOIDED" }: {
  actorId?: string | null; shopperId?: string; paymentStatus?: "VOIDED" | "REFUND_PENDING";
}) {
  await ensureNoPendingWarehousePosting(tx, order.id);
  const items = [...order.items].sort((a, b) => a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0);
  for (const item of items) {
    await tx.inventory.update({ where: { variantId: item.variantId }, data: { available: { increment: item.quantity } } });
  }
  await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  await tx.payment.update({ where: { orderId: order.id }, data: { status: paymentStatus } });
  await tx.fulfillmentEvent.create({
    data: { orderId: order.id, actorId, status: order.fulfillmentStatus, type: "ORDER_CANCELLED" },
  });
  await tx.auditEvent.create({ data: { actorId, action: "ORDER_CANCELLED", target: order.id,
    changes: { restoredLines: items.length, ...(shopperId && { shopperId }), paymentStatus } } });
}

export async function staffManualPayment(actorId: string, orderId: string) {
  const db = getDb();
  await authorize(db, actorId, true, "bd");
  if (!uuid.safeParse(orderId).success) return null;
  return db.bangladeshManualProof.findUnique({ where: { orderId }, select: {
    method: true, recipient: true, test: true, payerPhone: true, submittedTransaction: true, submittedAt: true,
    reviewedAt: true, reviewNote: true, verifiedTransaction: true,
  } });
}

export async function staffManualPaymentReceipt(actorId: string, orderId: string) {
  const db = getDb();
  await authorize(db, actorId, true, "bd");
  if (!uuid.safeParse(orderId).success) return null;
  return db.bangladeshManualProof.findUnique({ where: { orderId }, select: { receipt: true } });
}

const manualDecision = z.discriminatedUnion("approve", [
  z.object({ approve: z.literal(true), amountMinor: z.number().int().positive(), transaction: walletTransaction }),
  z.object({ approve: z.literal(false), note: shipmentText(300).min(3) }),
]);

export async function reviewManualPayment(actor: FulfillmentActor, orderId: string, input: unknown) {
  const parsed = manualDecision.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter the verified amount and transaction ID, or enter why payment could not be verified.");
  const decision = parsed.data;
  try {
    await getDb().$transaction(async tx => {
      const { order, actorId } = await lockFulfillmentOrder(tx, actor, orderId, { ownerOnly: true });
      const proof = await tx.bangladeshManualProof.findUnique({ where: { orderId },
        select: { reviewedAt: true, submittedTransaction: true, verifiedTransaction: true, test: true } });
      if (!proof || order.marketId !== "bd" || !isManualPaymentMethod(order.payment.method)) {
        throw new OperationError("This order has no manual wallet payment.");
      }
      if (typeof actor !== "string" && !proof.test) deny();
      if (proof.reviewedAt && (decision.approve
        ? order.payment.status === "PAID" && proof.verifiedTransaction === decision.transaction
        : order.payment.status === "VOIDED")) return;
      if (proof.reviewedAt || order.status !== "PLACED" || order.payment.status !== "AWAITING_VERIFICATION" ||
          order.fulfillmentStatus !== "UNFULFILLED") {
        throw new OperationError("This payment has already been reviewed or is no longer available.");
      }
      const reviewedAt = new Date();
      if (decision.approve) {
        if (decision.amountMinor !== order.payment.amountMinor) throw new OperationError("The received amount must match the order total.");
        if (proof.submittedTransaction && proof.submittedTransaction !== decision.transaction) {
          throw new OperationError("The verified transaction ID must match the shopper’s submission.");
        }
        await tx.bangladeshManualProof.update({ where: { orderId }, data: { reviewedAt, verifiedTransaction: decision.transaction } });
        await tx.payment.update({ where: { orderId }, data: { status: "PAID", collectedAt: reviewedAt, collectedById: actorId } });
      } else {
        await tx.bangladeshManualProof.update({ where: { orderId }, data: { reviewedAt, reviewNote: decision.note } });
        await cancelLockedUnshippedOrder(tx, order, { actorId });
      }
      await tx.auditEvent.create({ data: {
        actorId, target: orderId, action: decision.approve ? "MANUAL_PAYMENT_APPROVED" : "MANUAL_PAYMENT_DECLINED",
        changes: {
          method: order.payment.method, currency: order.payment.currency, amountMinor: order.payment.amountMinor,
          status: decision.approve ? "PAID" : "VOIDED", test: proof.test,
        },
      } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new OperationError("This wallet transaction was already verified on another order.");
    }
    throw error;
  }
}

export async function cancelOrder(actor: FulfillmentActor, orderId: string) {
  await getDb().$transaction(async (tx) => {
    const { order, actorId } = await lockFulfillmentOrder(tx, actor, orderId, { ownerOnly: true });
    if (order.status === "CANCELLED") return;
    if (!canCancelFrom.includes(order.fulfillmentStatus) || order.payment.status !== "AWAITING_COLLECTION") {
      throw new OperationError("Only unshipped orders awaiting collection can be cancelled.");
    }
    await cancelLockedUnshippedOrder(tx, order, { actorId });
  });
}

export async function collectCash(actor: FulfillmentActor, orderId: string) {
  await getDb().$transaction(async (tx) => {
    const { order, actorId } = await lockFulfillmentOrder(tx, actor, orderId, { ownerOnly: true });
    if (order.status !== "PLACED" || order.fulfillmentStatus !== "DELIVERED" || order.payment.method !== "COD") {
      throw new OperationError("Record COD collection after the order is delivered.");
    }
    if (order.marketId === "bd") {
      const shipment = await tx.bangladeshShipment.findUnique({ where: { orderId }, select: { status: true } });
      if (shipment && shipment.status !== "DELIVERED") throw new OperationError("Record COD collection after the courier confirms delivery.");
    }
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
      id: true, sku: true, label: true, product: { select: { name: true } },
      inventory: { select: { available: true } },
      offers: { orderBy: { marketId: "asc" }, select: { marketId: true, amountMinor: true } },
    },
  });
}

const stockChange = z.object({
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
  const parsed = stockChange.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter a nonzero whole-unit adjustment between −10,000 and 10,000 and explain the reason.");
  const { variantId, delta, reason } = parsed.data;
  await getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
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
    await authorize(tx, actorId, true, marketId);
    const variant = await tx.variant.findUnique({ where: { id: variantId }, select: { productId: true } });
    if (!variant) throw new OperationError("This SKU is unavailable.");
    await lockProductEdits(tx, variant.productId);
    const rows = await tx.$queryRaw<{ amountMinor: number; discountMinor: number | null }[]>`
      SELECT "amountMinor", "discountMinor" FROM "MarketOffer"
      WHERE "variantId" = ${variantId} AND "marketId" = ${marketId}::"MarketCode" FOR UPDATE
    `;
    const offer = rows[0];
    if (!offer) throw new OperationError("That variant is not listed in the selected market.");
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
