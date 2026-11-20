import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { FulfillmentStatus, OrderParcelStatus } from "../../generated/prisma/enums.ts";
import { getDb } from "../db/client.ts";
import { authorizeOrderOperation, OperationError, operationsScope } from "../staff/operations.ts";
import { demoHandoff, devShipmentAvailable } from "./bangladesh-shipment.ts";
import { uuid } from "./checkout-types.ts";
import { changeAllocatedStock, InventoryLocationError, lockVariantInventory } from "./location-inventory.ts";
import { dispatchOrderStock, lockConnectedOrderAttempt, restockRefusedParcel } from "./order-inventory.ts";
import { canAdvanceParcelTracking, currentParcelTrackingStatus, nextOrderParcelStatuses, normalizedParcelEventStatus, parcelWasRefused } from "./parcel-tracking.ts";
import { orderHasAdapter } from "./market-commerce.ts";

const referenceText = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\u0000-\u001f\u007f]+$/u);
const handoff = z.object({ carrier: referenceText(60), trackingReference: referenceText(80) });
const reasonText = referenceText(200).min(3);
const dispatchInput = handoff.partial().extend({ simulate: z.boolean().optional(), reason: reasonText.optional() });
const trackingInput = z.object({
  status: z.enum(["OUT_FOR_DELIVERY", "DELIVERED", "REFUSED"]),
  evidence: reasonText.optional(), reason: reasonText.optional(),
});
const receiptInput = z.object({ disposition: z.enum(["RESTOCK", "HOLD"]), note: z.string().trim().min(3).max(200) });
const splitInput = z.object({ operationId: uuid, reason: reasonText,
  items: z.array(z.object({ orderItemId: uuid, quantity: z.int().positive() })).min(1).max(100),
}).refine(({ items }) => new Set(items.map(item => item.orderItemId)).size === items.length);
const referenceInput = handoff.extend({ reason: reasonText, expectedRevision: z.int().nonnegative() });
const exceptionInput = z.object({ reason: reasonText });

// Fulfillment, cancellation, and collection share the order lock, including when they affect one parcel.
async function lockOrderParcel(tx: Prisma.TransactionClient, actorId: string, orderId: string, parcelId: string, ownerOnly = false) {
  if (!uuid.safeParse(orderId).success || !uuid.safeParse(parcelId).success) throw new OperationError("Parcel not found.");
  const scope = await operationsScope(tx, actorId, ownerOnly);
  const connectedAttempt = await lockConnectedOrderAttempt(tx, orderId);
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
  const parcel = await tx.orderParcel.findFirst({
    where: { id: parcelId, orderId, order: scope },
    include: {
      order: { select: { marketId: true, measurementTest: true, commercialSnapshot: true, status: true, fulfillmentStatus: true,
        payment: { select: { method: true, status: true } } } },
      items: { select: { orderItemId: true, quantity: true, orderItem: { select: { orderId: true, variantId: true, offerIdSnapshot: true } } } },
    },
  });
  if (!parcel) throw new OperationError("There is no active parcel for this order.");
  await authorizeOrderOperation(tx, actorId, parcel.order.marketId, ownerOnly);
  if (!parcel.order.payment || parcel.order.status !== "PLACED") throw new OperationError("There is no active parcel for this order.");
  return { ...parcel, connectedAttempt, order: { ...parcel.order, payment: parcel.order.payment } };
}

type LockedParcel = Awaited<ReturnType<typeof lockOrderParcel>>;
type ParcelTrackingFields = Pick<Prisma.OrderParcelUpdateInput, "carrier" | "trackingReference" | "source" | "receivedAt" | "returnDisposition">;

async function recordParcelEvent(tx: Prisma.TransactionClient, parcel: LockedParcel, actorId: string, status: OrderParcelStatus, details: {
  fields?: ParcelTrackingFields;
  evidence?: string;
  reason?: string;
  audit?: Prisma.InputJsonObject;
} = {}) {
  const recordedAt = new Date();
  const trackingStatus = normalizedParcelEventStatus(status);
  const tracking = canAdvanceParcelTracking(currentParcelTrackingStatus(parcel), trackingStatus)
    ? { trackingStatus, trackingOccurredAt: new Date(Math.max(+recordedAt, +(parcel.trackingOccurredAt ?? recordedAt))) } : {};
  await tx.orderParcel.update({ where: { id: parcel.id }, data: { ...details.fields, ...tracking, status, statusUpdatedAt: recordedAt,
    trackingRevision: { increment: 1 } } });
  await tx.orderParcelEvent.create({ data: { parcelId: parcel.id, status, actorId, evidence: details.evidence, reason: details.reason, recordedAt } });
  await tx.auditEvent.create({
    data: {
      actorId, target: parcel.orderId, action: "FULFILLMENT_CHANGED",
      changes: { parcelId: parcel.id, locationId: parcel.locationId, from: parcel.status, to: status,
        ...(details.reason && { reason: details.reason }), ...details.audit },
    },
  });
}

export function canEditParcelReference(parcel: { status: OrderParcelStatus; trackingSyncedAt: Date | null }) {
  return !parcel.trackingSyncedAt && (parcel.status === "PLANNED" || parcel.status === "IN_TRANSIT" || parcel.status === "OUT_FOR_DELIVERY");
}

async function ensureUniqueReference(tx: Prisma.TransactionClient, parcel: LockedParcel, trackingReference: string) {
  if (await tx.orderParcel.findFirst({
    where: { orderId: parcel.orderId, id: { not: parcel.id }, trackingReference: { equals: trackingReference, mode: "insensitive" } },
    select: { id: true },
  })) throw new OperationError("Another parcel on this order already uses that tracking reference.");
}

export async function splitOrderParcel(actorId: string, orderId: string, parcelId: string, raw: unknown) {
  const parsed = splitInput.safeParse(raw);
  if (!parsed.success) throw new OperationError("Choose distinct order lines, positive quantities, and a reason for the split.");
  const { operationId, items, reason } = parsed.data;
  const ordered = [...items].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
  const splitRequestHash = createHash("sha256").update(JSON.stringify([parcelId, reason, ordered])).digest("hex");
  return getDb().$transaction(async tx => {
    const parcel = await lockOrderParcel(tx, actorId, orderId, parcelId);
    const previous = await tx.orderParcel.findUnique({ where: { id: operationId }, select: { orderId: true, splitRequestHash: true } });
    if (previous) {
      if (previous.orderId === orderId && previous.splitRequestHash === splitRequestHash) return { parcelId: operationId };
      throw new OperationError("This package request has already been used for a different split.");
    }
    if (parcel.status !== "PLANNED" || parcel.items.some(line => line.orderItem.orderId !== orderId)) {
      throw new OperationError("Only a planned package for this order can be split.");
    }
    const amounts = new Map(parcel.items.map(line => [line.orderItemId, line.quantity]));
    if (items.some(line => line.quantity > (amounts.get(line.orderItemId) ?? 0)) ||
        items.reduce((total, line) => total + line.quantity, 0) >= parcel.items.reduce((total, line) => total + line.quantity, 0)) {
      throw new OperationError("Move only allocated quantities and leave at least one unit in the original package.");
    }
    for (const item of items) {
      const where = { parcelId_orderItemId: { parcelId, orderItemId: item.orderItemId } };
      if (item.quantity === amounts.get(item.orderItemId)) await tx.orderParcelItem.delete({ where });
      else await tx.orderParcelItem.update({ where, data: { quantity: { decrement: item.quantity } } });
    }
    await tx.orderParcel.create({ data: { id: operationId, orderId, locationId: parcel.locationId, locationName: parcel.locationName,
      splitRequestHash, items: { createMany: { data: items } }, events: { create: { status: "PLANNED", actorId, reason } } } });
    await tx.orderParcel.update({ where: { id: parcelId }, data: { trackingRevision: { increment: 1 } } });
    await tx.auditEvent.create({ data: { action: "FULFILLMENT_CHANGED", actorId, target: orderId,
      changes: { type: "PARCEL_SPLIT", parcelId, newParcelId: operationId, locationId: parcel.locationId, items, reason } } });
    return { parcelId: operationId };
  });
}

export async function updateOrderParcelReference(actorId: string, orderId: string, parcelId: string, raw: unknown) {
  const input = referenceInput.safeParse(raw);
  if (!input.success) throw new OperationError("Enter a carrier, tracking reference, and reason.");
  const { carrier, trackingReference, expectedRevision, reason } = input.data;
  return getDb().$transaction(async tx => {
    const parcel = await lockOrderParcel(tx, actorId, orderId, parcelId);
    if (parcel.trackingRevision !== expectedRevision || !canEditParcelReference(parcel)) {
      throw new OperationError("The tracking reference has changed or already has carrier evidence. Refresh before editing.");
    }
    if (parcel.carrier === carrier && parcel.trackingReference === trackingReference) return;
    await ensureUniqueReference(tx, parcel, trackingReference);
    await tx.orderParcel.update({ where: { id: parcelId }, data: { carrier, trackingReference, trackingRevision: { increment: 1 },
      trackingReportedAt: null, trackingAttemptAt: null, trackingSyncError: null, estimatedDeliveryAt: null } });
    await tx.parcelTrackingObservation.create({ data: { parcelId, actorId, source: "MANUAL", reason, occurredAt: new Date() } });
    await tx.auditEvent.create({ data: { action: "FULFILLMENT_CHANGED", actorId, target: orderId, changes: {
      type: "PARCEL_REFERENCE_UPDATED", parcelId, reason, from: { carrier: parcel.carrier, trackingReference: parcel.trackingReference },
      to: { carrier, trackingReference },
    } } });
  });
}

export function canRecordParcelException(parcel: { status: OrderParcelStatus; trackingStatus: ReturnType<typeof currentParcelTrackingStatus> | null }) {
  return (parcel.status === "IN_TRANSIT" || parcel.status === "OUT_FOR_DELIVERY") &&
    canAdvanceParcelTracking(currentParcelTrackingStatus(parcel), "DELIVERY_EXCEPTION");
}

export async function recordOrderParcelException(actorId: string, orderId: string, parcelId: string, raw: unknown) {
  const input = exceptionInput.safeParse(raw);
  if (!input.success) throw new OperationError("Enter a reason for the delivery exception.");
  return getDb().$transaction(async tx => {
    const parcel = await lockOrderParcel(tx, actorId, orderId, parcelId);
    if (!canRecordParcelException(parcel)) throw new OperationError("This parcel cannot receive a delivery exception.");
    const recordedAt = new Date();
    const { reason } = input.data;
    if (parcel.trackingStatus === "DELIVERY_EXCEPTION" && parcel.trackingOccurredAt && await tx.parcelTrackingObservation.findFirst({
      where: { parcelId, source: "MANUAL", actorId, status: "DELIVERY_EXCEPTION", reason, occurredAt: parcel.trackingOccurredAt }, select: { id: true },
    })) return;
    await tx.parcelTrackingObservation.create({ data: { parcelId, actorId, source: "MANUAL", status: "DELIVERY_EXCEPTION", reason,
      occurredAt: recordedAt, recordedAt, applied: true } });
    await tx.orderParcel.update({ where: { id: parcelId }, data: { trackingStatus: "DELIVERY_EXCEPTION", trackingOccurredAt: recordedAt,
      trackingRevision: { increment: 1 } } });
    await tx.auditEvent.create({ data: { action: "FULFILLMENT_CHANGED", actorId, target: orderId,
      changes: { type: "PARCEL_DELIVERY_EXCEPTION", parcelId, reason } } });
  });
}

async function setFulfillment(tx: Prisma.TransactionClient, orderId: string, actorId: string, status: FulfillmentStatus) {
  await tx.order.update({ where: { id: orderId }, data: { fulfillmentStatus: status } });
  await tx.fulfillmentEvent.create({ data: { orderId, status, actorId, type: "STATUS_CHANGED" } });
}

export async function dispatchOrderParcel(actorId: string, orderId: string, parcelId: string, raw: unknown) {
  const input = dispatchInput.safeParse(raw);
  if (!input.success) throw new OperationError("Enter a valid carrier and tracking reference.");
  const { simulate } = input.data;
  return getDb().$transaction(async tx => {
    const parcel = await lockOrderParcel(tx, actorId, orderId, parcelId);
    const { order } = parcel;
    if (simulate && !devShipmentAvailable(order)) throw new OperationError("The demo courier is available only for test orders.");
    if (!simulate && !orderHasAdapter(order, "fulfillment", "manual")) throw new OperationError("This order requires its configured fulfillment adapter.");
    if (parcel.status !== "PLANNED") {
      const duplicate = simulate ? parcel.source === "DEV_SIMULATOR"
        : parcel.source === "MANUAL" && parcel.carrier === input.data.carrier && parcel.trackingReference === input.data.trackingReference;
      if (duplicate) return;
      throw new OperationError("This parcel has already been handed off.");
    }
    if (order.fulfillmentStatus !== "READY_TO_SHIP" && order.fulfillmentStatus !== "SHIPPED") {
      throw new OperationError("Mark the order ready to ship before dispatching its parcels.");
    }
    if (order.payment.method === "COD" ? order.payment.status !== "AWAITING_COLLECTION" : order.payment.status !== "PAID") {
      throw new OperationError("Review the payment before releasing this parcel.");
    }
    if (await tx.orderCase.findFirst({
      where: { orderId, kind: "CANCEL", status: { in: ["OPEN", "IN_REVIEW"] } }, select: { id: true },
    })) throw new OperationError("Review the shopper’s pending cancellation before shipping this order.");
    if (!parcel.items.length || parcel.items.some(line => line.orderItem.orderId !== orderId)) {
      throw new OperationError("This parcel’s items do not match the order.");
    }

    const tracking = handoff.safeParse(simulate ? demoHandoff() : {
      carrier: input.data.carrier ?? parcel.carrier, trackingReference: input.data.trackingReference ?? parcel.trackingReference,
    });
    if (!tracking.success) throw new OperationError("Enter a carrier and tracking reference before dispatching.");
    const { carrier, trackingReference } = tracking.data;
    if ((parcel.carrier && parcel.carrier !== carrier) || (parcel.trackingReference && parcel.trackingReference !== trackingReference)) {
      throw new OperationError("Update the saved carrier and tracking reference before confirming the handoff.");
    }
    await ensureUniqueReference(tx, parcel, trackingReference);
    const source = simulate ? "DEV_SIMULATOR" : "MANUAL";
    if (parcel.connectedAttempt) await dispatchOrderStock(tx, actorId, parcel.connectedAttempt, parcel, trackingReference);
    await recordParcelEvent(tx, parcel, actorId, "IN_TRANSIT", { fields: { carrier, trackingReference, source },
      reason: input.data.reason ?? (simulate ? "Test parcel handoff" : "Physical handoff recorded by staff"), audit: { source } });
    if (order.fulfillmentStatus === "READY_TO_SHIP") await setFulfillment(tx, orderId, actorId, "SHIPPED");
  });
}

export async function recordOrderParcelTracking(actorId: string, orderId: string, parcelId: string, raw: unknown) {
  const input = trackingInput.safeParse(raw);
  if (!input.success) throw new OperationError("Choose a parcel status and enter a valid evidence reference if required.");
  const { status, evidence, reason } = input.data;
  return getDb().$transaction(async tx => {
    const parcel = await lockOrderParcel(tx, actorId, orderId, parcelId, status === "REFUSED");
    const { order } = parcel;
    const simulated = parcel.source === "DEV_SIMULATOR";
    if (simulated && !devShipmentAvailable(order)) throw new OperationError("The demo courier is available only for test orders.");
    if (parcel.status === status) return;
    if (order.fulfillmentStatus !== "SHIPPED" || !nextOrderParcelStatuses(parcel.status).includes(status)) {
      throw new OperationError("That parcel status is no longer available. Refresh the order and try again.");
    }
    if (status !== "REFUSED" && !canAdvanceParcelTracking(currentParcelTrackingStatus(parcel), normalizedParcelEventStatus(status))) {
      throw new OperationError("That update would contradict the current tracking outcome.");
    }
    if (!simulated && !evidence && !reason) throw new OperationError("Enter the reason or courier’s event reference.");
    if (status === "REFUSED" && order.payment.method === "COD" && order.payment.status !== "AWAITING_COLLECTION") {
      throw new OperationError("Review the COD payment before recording a refused parcel.");
    }
    const otherParcels = status === "OUT_FOR_DELIVERY" ? [] : await tx.orderParcel.findMany({
      where: { orderId, id: { not: parcelId } }, select: { status: true },
    });
    const voidedCod = status === "REFUSED" && order.payment.method === "COD" && otherParcels.every(parcelWasRefused);
    await recordParcelEvent(tx, parcel, actorId, status, {
      evidence: simulated ? undefined : evidence, reason: reason ?? evidence,
      audit: { source: simulated ? "DEV_SIMULATOR" : "MANUAL", ...(voidedCod && { paymentStatus: "VOIDED" }) },
    });
    if (status === "DELIVERED" && otherParcels.every(row => row.status === "DELIVERED")) {
      await setFulfillment(tx, orderId, actorId, "DELIVERED");
    }
    if (voidedCod) {
      await tx.payment.update({ where: { orderId }, data: { status: "VOIDED" } });
    }
  });
}

export async function receiveRefusedOrderParcel(actorId: string, orderId: string, parcelId: string, raw: unknown) {
  const input = receiptInput.safeParse(raw);
  if (!input.success) throw new OperationError("Choose how to handle the stock and enter a warehouse note (3 to 200 characters).");
  const { disposition, note } = input.data;
  return getDb().$transaction(async tx => {
    const parcel = await lockOrderParcel(tx, actorId, orderId, parcelId);
    if (!orderHasAdapter(parcel.order, "returns", "manual")) throw new OperationError("This order requires its configured returns adapter.");
    if (parcel.status === "RETURNED" && parcel.returnDisposition !== disposition) {
      throw new OperationError("A receipt already exists with a different stock decision. Refresh the order.");
    }
    if ((parcel.status !== "RETURNED" && parcel.status !== "REFUSED") ||
        !parcel.items.length || parcel.items.some(line => line.orderItem.orderId !== orderId)) {
      throw new OperationError("Only a refused parcel with valid items can be received.");
    }
    const restockedUnits = disposition === "RESTOCK" ? parcel.items.reduce((units, line) => units + line.quantity, 0) : 0;
    if (parcel.status === "RETURNED") return { disposition, restockedUnits };
    if (restockedUnits) {
      try {
        if (parcel.connectedAttempt) {
          await lockVariantInventory(tx, parcel.items.map(line => line.orderItem.variantId));
          await restockRefusedParcel(tx, actorId, parcel.connectedAttempt, parcel);
        }
        await changeAllocatedStock(tx, parcel.items.filter(line => !line.orderItem.offerIdSnapshot).map(line => ({
          variantId: line.orderItem.variantId, locationId: parcel.locationId, quantity: line.quantity,
        })), false);
      } catch (error) {
        if (error instanceof InventoryLocationError) throw new OperationError(error.message);
        throw error;
      }
    }
    await recordParcelEvent(tx, parcel, actorId, "RETURNED", {
      fields: { receivedAt: new Date(), returnDisposition: disposition }, evidence: note, reason: note,
      audit: { disposition, restockedUnits },
    });
    return { disposition, restockedUnits };
  });
}
