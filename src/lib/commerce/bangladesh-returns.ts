import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { variantQuantities } from "../cart/model.ts";
import { getDb } from "../db/client.ts";
import { lockFulfillmentOrder, OperationError, type FulfillmentActor } from "../staff/operations.ts";
import {
  ensureNoPendingWarehousePosting, postWarehouseMovement, recordWarehouseReturnCost, runWarehouseOperation,
  warehouseFingerprint, warehouseRefusedKey, warehouseReturnRequest, warehouseTransactionOptions,
} from "../staff/hybrid-warehouse.ts";
import { uuid } from "./checkout-types.ts";
import { isManualPaymentMethod } from "./manual-payment-methods.ts";

const disposition = z.enum(["RESTOCK", "HOLD"]);
const warehouseNote = z.string().trim().min(3).max(500);
export const warehouseReturnInput = z.object({ disposition, note: warehouseNote });

type StockLine = { variantId: string; quantity: number };

// Checkout and stock operations acquire inventory locks in the same variant order.
export async function restoreBangladeshInventory(tx: Prisma.TransactionClient, lines: readonly StockLine[]) {
  if (!lines.length) throw new OperationError("There are no returned items to restock.");
  const quantities = [...variantQuantities(lines)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [variantId, quantity] of quantities) {
    const result = await tx.inventory.updateMany({
      where: { variantId }, data: { available: { increment: quantity } },
    });
    if (result.count !== 1) throw new OperationError("A stock record is missing. No receipt or stock change was saved.");
  }
  return quantities.reduce((units, [, quantity]) => units + quantity, 0);
}

export async function receiveBangladeshRefusedParcel(actor: FulfillmentActor, orderId: string, raw: unknown) {
  if (!uuid.safeParse(orderId).success) throw new OperationError("Order not found.");
  const parsed = warehouseReturnInput.safeParse(raw);
  if (!parsed.success) throw new OperationError("Choose how to handle the stock and enter a warehouse note (3 to 500 characters).");
  const { disposition, note } = parsed.data;

  return runWarehouseOperation(complete => getDb().$transaction(async tx => {
    const { order, actorId } = await lockFulfillmentOrder(tx, actor, orderId, { bangladeshOnly: true, returns: true });
    const shipment = await tx.bangladeshShipment.findUnique({ where: { orderId }, select: { status: true } });
    if (order.status !== "PLACED" || order.fulfillmentStatus !== "SHIPPED" || shipment?.status !== "REFUSED") {
      throw new OperationError("Only a refused Bangladesh parcel can be received this way.");
    }
    const prior = await tx.bangladeshRefusedParcelReceipt.findUnique({ where: { orderId },
      select: { disposition: true, restockedUnits: true } });
    if (prior) {
      if (prior.disposition !== disposition) throw new OperationError("A receipt already exists with a different stock decision. Refresh the order.");
      return prior;
    }
    const payment = order.payment;
    const prepaid = payment && (payment.method === "SSLCOMMERZ" || isManualPaymentMethod(payment.method));
    if (!((payment?.method === "COD" && payment.status === "VOIDED") || (prepaid && payment.status === "PAID"))) {
      throw new OperationError("The payment status needs review before recording this receipt.");
    }

    const key = warehouseRefusedKey(orderId);
    await ensureNoPendingWarehousePosting(tx, orderId, key);
    const request = await warehouseReturnRequest(tx, orderId, orderId,
      order.items.map(item => ({ itemId: item.id, quantity: item.quantity })), disposition,
      typeof actor === "string" ? { ownerActorId: actorId } : { operatorId: actor.id });
    const posting = request && await postWarehouseMovement(tx, { key,
      fingerprint: warehouseFingerprint([disposition, note]), request }, complete);
    if (posting && !("evidence" in posting)) return posting;
    const movement = posting?.evidence;
    const restockedUnits = disposition === "RESTOCK" ? await restoreBangladeshInventory(tx, order.items) : 0;
    const receipt = await tx.bangladeshRefusedParcelReceipt.create({
      data: { orderId, receivedById: actorId, disposition, restockedUnits, note,
        ...(movement && { receivedAt: new Date(movement.recordedAt) }) },
      select: { disposition: true, restockedUnits: true },
    });
    await recordWarehouseReturnCost(tx, movement, restockedUnits, { refusedOrderId: orderId });
    await tx.auditEvent.create({
      data: { actorId, target: orderId, action: "BD_REFUSED_PARCEL_RECEIVED", changes: { disposition, restockedUnits } },
    });
    return receipt;
  }, warehouseTransactionOptions));
}
