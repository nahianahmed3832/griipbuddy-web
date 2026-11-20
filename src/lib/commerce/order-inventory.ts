import type { Prisma } from "../../generated/prisma/client.ts";
import { OperationError } from "../staff/operation-error.ts";
import { requestDigest } from "./guest.ts";
import {
  cancelInventoryCommitment, dispatchInventoryAllocation, InventoryReservationError, releaseOrderAllocationUnits, restockInventoryAllocation,
} from "./inventory-reservations.ts";
import { InventoryLocationError, lockVariantInventory, parcelQuantitiesByLocation, restoreOrderInventory, type LocationReceiptLine } from "./location-inventory.ts";
import { applyInventoryMovement } from "./physical-inventory.ts";

type Tx = Prisma.TransactionClient;
type PurchasedLine = LocationReceiptLine & { offerIdSnapshot: string | null };

export async function lockConnectedOrderAttempt(tx: Tx, orderId: string) {
  const reservation = await tx.inventoryReservation.findUnique({ where: { orderId }, select: { attemptId: true } });
  if (reservation) {
    await tx.$queryRaw`SELECT id FROM "CheckoutAttempt" WHERE id = ${reservation.attemptId}::uuid FOR UPDATE`;
  }
  return reservation?.attemptId ?? null;
}

async function inventoryOperation<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof InventoryLocationError || error instanceof InventoryReservationError) throw new OperationError(error.message);
    throw error;
  }
}

export async function releaseUnshippedOrderStock(tx: Tx, actorId: string, attemptId: string | null, lines: readonly PurchasedLine[],
    verifiedPayPalRefundId?: string) {
  await inventoryOperation(async () => {
    if (attemptId) await lockVariantInventory(tx, lines.map(line => line.variantId));
    if (attemptId) await cancelInventoryCommitment(tx, actorId, attemptId, verifiedPayPalRefundId);
    await restoreOrderInventory(tx, attemptId ? lines.filter(line => !line.offerIdSnapshot) : lines);
  });
}

async function orderAllocations(tx: Tx, attemptId: string) {
  const reservation = await tx.inventoryReservation.findUnique({
    where: { attemptId, state: "COMMITTED" }, select: { allocations: { select: {
      id: true, poolId: true, offerId: true, quantity: true, dispatched: true, returned: true, cancelledQuantity: true,
      pool: { select: { variantId: true, locationId: true } },
    } } },
  });
  if (!reservation) throw new OperationError("There is no committed inventory for this order.");
  return reservation.allocations;
}

type Allocation = Awaited<ReturnType<typeof orderAllocations>>[number];
const findAllocation = (rows: Allocation[], locationId: string, line: { variantId: string; offerIdSnapshot: string | null }) =>
  rows.find(row => row.offerId === line.offerIdSnapshot && row.pool.variantId === line.variantId && row.pool.locationId === locationId);

type Parcel = {
  id: string;
  orderId: string;
  locationId: string;
};

async function parcelAllocations(tx: Tx, attemptId: string, parcel: Parcel) {
  const rows = await orderAllocations(tx, attemptId);
  const originLines = await tx.orderParcelItem.findMany({
    where: { parcel: { orderId: parcel.orderId, locationId: parcel.locationId } },
    select: { parcelId: true, quantity: true, cancelledQuantity: true, orderItem: { select: { orderId: true, variantId: true, offerIdSnapshot: true } } },
  });
  const quantities = new Map<Allocation, number>();
  const originQuantities = new Map<Allocation, number>();
  for (const line of originLines) {
    if (line.orderItem.orderId !== parcel.orderId) throw new OperationError("The parcel is linked to another order.");
    if (!line.orderItem.offerIdSnapshot) continue;
    const allocation = findAllocation(rows, parcel.locationId, line.orderItem);
    if (!allocation) throw new OperationError("The parcel is missing its original warehouse allocation.");
    originQuantities.set(allocation, (originQuantities.get(allocation) ?? 0) + line.quantity);
    const active = line.quantity - line.cancelledQuantity;
    if (line.parcelId === parcel.id && active) quantities.set(allocation, (quantities.get(allocation) ?? 0) + active);
  }
  const attributed = rows.filter(row => row.pool.locationId === parcel.locationId);
  if (attributed.some(allocation => originQuantities.get(allocation) !== allocation.quantity)) {
    throw new OperationError("The parcel quantities differ from the original warehouse allocation.");
  }
  return quantities;
}

export async function cancelPlannedOrderItems(tx: Tx, actorId: string, orderId: string, attemptId: string,
  requested: readonly { orderItemId: string; quantity: number }[]) {
  return inventoryOperation(async () => {
    const lines = await tx.orderParcelItem.findMany({
      where: { parcel: { orderId, status: "PLANNED", cancelledAt: null }, orderItemId: { in: requested.map(line => line.orderItemId) } },
      orderBy: [{ parcelId: "asc" }, { orderItemId: "asc" }],
      select: { parcelId: true, orderItemId: true, quantity: true, cancelledQuantity: true,
        parcel: { select: { locationId: true } },
        orderItem: { select: { orderId: true, variantId: true, offerIdSnapshot: true } } },
    });
    const rows = await orderAllocations(tx, attemptId);
    const released = new Map<Allocation, number>();
    const affected = new Set<string>();
    const changes = [];
    for (const item of requested) {
      let remaining = item.quantity;
      for (const line of lines) {
        if (line.orderItemId !== item.orderItemId || !remaining) continue;
        const quantity = Math.min(remaining, line.quantity - line.cancelledQuantity);
        if (!quantity) continue;
        const allocation = findAllocation(rows, line.parcel.locationId, line.orderItem);
        if (line.orderItem.orderId !== orderId || !allocation) throw new OperationError("The item needs a recorded parcel and warehouse allocation.");
        changes.push({ parcelId: line.parcelId, orderItemId: line.orderItemId, allocationId: allocation.id, quantity });
        remaining -= quantity;
        affected.add(line.parcelId);
        released.set(allocation, (released.get(allocation) ?? 0) + quantity);
      }
      if (remaining) throw new OperationError("The selected quantity is no longer in an undispatched parcel.");
    }

    await lockVariantInventory(tx, [...released.keys()].map(row => row.pool.variantId));
    for (const [row, quantity] of released) await releaseOrderAllocationUnits(tx, actorId, attemptId, row.id, quantity);
    for (const { parcelId, orderItemId, quantity } of changes) {
      await tx.orderParcelItem.update({ where: { parcelId_orderItemId: { parcelId, orderItemId } },
        data: { cancelledQuantity: { increment: quantity } } });
    }
    for (const id of affected) {
      const items = await tx.orderParcelItem.findMany({ where: { parcelId: id }, select: { quantity: true, cancelledQuantity: true } });
      const cancelledAt = items.every(line => line.quantity === line.cancelledQuantity) ? new Date() : null;
      await tx.orderParcel.update({ where: { id }, data: { cancelledAt, preparationState: "PENDING", trackingRevision: { increment: 1 } } });
    }
    return changes;
  });
}

export async function dispatchOrderStock(tx: Tx, actorId: string, attemptId: string, parcel: Parcel, reference: string) {
  await inventoryOperation(async () => {
    const allocations = await parcelAllocations(tx, attemptId, parcel);
    await lockVariantInventory(tx, [...allocations.keys()].map(row => row.pool.variantId));
    for (const [row, quantity] of allocations) {
      await dispatchInventoryAllocation(tx, actorId, attemptId, { allocationId: row.id, eventId: parcel.id, reference, quantity });
    }
  });
}

// The caller holds the attempt and order locks and has verified a physical refused-parcel receipt.
export async function restockRefusedParcel(tx: Tx, actorId: string, attemptId: string, parcel: Parcel) {
  const allocations = await parcelAllocations(tx, attemptId, parcel);
  await lockVariantInventory(tx, [...allocations.keys()].map(row => row.pool.variantId));
  for (const [row, quantity] of allocations) {
    if (quantity > row.dispatched - row.returned) throw new OperationError("The receipt exceeds the dispatched stock for this parcel.");
    const result = await applyInventoryMovement(tx, {
      allocationId: row.id, poolId: row.poolId, kind: "RETURN", quantity,
      idempotencyKey: requestDigest(JSON.stringify(["refused-parcel", parcel.id, row.id])),
      reason: "Inspected refused parcel approved for restock", reference: parcel.id, actorId,
    });
    if (!result.replayed) await tx.inventoryAllocation.update({ where: { id: row.id }, data: { returned: { increment: quantity } } });
  }
}

export async function restockInspectedOrderLines(tx: Tx, actorId: string, attemptId: string, caseId: string, lines: PurchasedLine[]) {
  return inventoryOperation(async () => {
    // Lock legacy and connected variants together before applying any of their movements.
    await lockVariantInventory(tx, lines.map(line => line.variantId));
    const receipts = await restoreOrderInventory(tx, lines.filter(line => !line.offerIdSnapshot));
    const connected = lines.filter(line => line.offerIdSnapshot);
    if (!connected.length) return receipts;
    const rows = await orderAllocations(tx, attemptId);
    const parcels = await tx.orderParcelItem.findMany({
      where: { orderItemId: { in: connected.map(line => line.id) }, parcel: { status: "DELIVERED" } },
      select: { orderItemId: true, quantity: true, cancelledQuantity: true, parcel: { select: { locationId: true } } },
    });
    for (const line of connected) {
      const sources = parcelQuantitiesByLocation(parcels.filter(row => row.orderItemId === line.id && row.quantity > row.cancelledQuantity)
        .map(row => ({ ...row, quantity: row.quantity - row.cancelledQuantity })));
      const shipped = [...sources.values()].reduce((total, quantity) => total + quantity, 0);
      if (!sources.size || line.quantity + (line.receivedBefore ?? 0) > shipped) {
        throw new OperationError("The receipt exceeds the original delivered parcel quantities.");
      }
      if (sources.size > 1 && line.quantity !== shipped) {
        throw new OperationError("This item shipped from several warehouses. Hold this partial return to confirm its source.");
      }
      for (const [locationId, quantity] of sources) {
        const allocation = findAllocation(rows, locationId, line);
        if (!allocation) throw new OperationError("The return is missing its original warehouse allocation.");
        await restockInventoryAllocation(tx, actorId, attemptId, {
          allocationId: allocation.id, caseId, orderItemId: line.id, quantity: sources.size === 1 ? line.quantity : quantity,
        });
      }
    }
    return receipts + connected.reduce((total, line) => total + line.quantity, 0);
  });
}
