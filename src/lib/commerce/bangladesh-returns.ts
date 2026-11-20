import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { authorizeOrderOperation, OperationError, operationsScope } from "../staff/operations.ts";
import { uuid } from "./checkout-types.ts";
import { InventoryLocationError, restoreOrderInventory, type LocationReceiptLine } from "./location-inventory.ts";

const disposition = z.enum(["RESTOCK", "HOLD"]);
const warehouseNote = z.string().trim().min(3).max(500);
export const warehouseReturnInput = z.object({ disposition, note: warehouseNote });

export async function restoreBangladeshInventory(tx: Prisma.TransactionClient, lines: readonly LocationReceiptLine[]) {
  if (!lines.length) throw new OperationError("There are no returned items to restock.");
  try {
    return await restoreOrderInventory(tx, lines);
  } catch (error) {
    if (error instanceof InventoryLocationError) throw new OperationError(error.message);
    throw error;
  }
}

export async function receiveBangladeshRefusedParcel(actorId: string, orderId: string, raw: unknown) {
  if (!uuid.safeParse(orderId).success) throw new OperationError("Order not found.");
  const parsed = warehouseReturnInput.safeParse(raw);
  if (!parsed.success) throw new OperationError("Choose how to handle the stock and enter a warehouse note (3 to 500 characters).");
  const { disposition, note } = parsed.data;

  return getDb().$transaction(async tx => {
    const scope = await operationsScope(tx, actorId);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { AND: [{ id: orderId }, scope] },
      select: {
        status: true, fulfillmentStatus: true, marketId: true,
        payment: { select: { method: true, status: true } },
        bangladeshShipment: { select: { status: true } },
        bangladeshRefusedParcelReceipt: { select: { disposition: true, restockedUnits: true } },
        items: { select: { id: true, variantId: true, quantity: true } },
      },
    });
    if (!order) throw new OperationError("Order not found.");
    await authorizeOrderOperation(tx, actorId, order.marketId);
    if (order.status !== "PLACED" || order.fulfillmentStatus !== "SHIPPED" ||
        order.bangladeshShipment?.status !== "REFUSED") {
      throw new OperationError("Only a refused courier parcel can be received this way.");
    }
    const prior = order.bangladeshRefusedParcelReceipt;
    if (prior) {
      if (prior.disposition !== disposition) throw new OperationError("A receipt already exists with a different stock decision. Refresh the order.");
      return prior;
    }
    if (!((order.payment?.method === "COD" && order.payment.status === "VOIDED") ||
          (order.payment?.method === "SSLCOMMERZ" && order.payment.status === "PAID"))) {
      throw new OperationError("The payment status needs review before recording this receipt.");
    }

    const restockedUnits = disposition === "RESTOCK" ? await restoreBangladeshInventory(tx, order.items) : 0;
    const receipt = await tx.bangladeshRefusedParcelReceipt.create({
      data: { orderId, receivedById: actorId, disposition, restockedUnits, note },
      select: { disposition: true, restockedUnits: true },
    });
    await tx.auditEvent.create({
      data: { actorId, target: orderId, action: "BD_REFUSED_PARCEL_RECEIVED", changes: { disposition, restockedUnits } },
    });
    return receipt;
  });
}
