import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { variantQuantities } from "../cart/model.ts";
import { getDb } from "../db/client.ts";
import { authorize, OperationError } from "../staff/operations.ts";
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

export async function receiveBangladeshRefusedParcel(actorId: string, orderId: string, raw: unknown) {
  if (!uuid.safeParse(orderId).success) throw new OperationError("Order not found.");
  const parsed = warehouseReturnInput.safeParse(raw);
  if (!parsed.success) throw new OperationError("Choose how to handle the stock and enter a warehouse note (3 to 500 characters).");
  const { disposition, note } = parsed.data;

  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, false, "bd");
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        status: true, fulfillmentStatus: true, marketId: true,
        payment: { select: { method: true, status: true } },
        bangladeshShipment: { select: { status: true } },
        bangladeshRefusedParcelReceipt: { select: { disposition: true, restockedUnits: true } },
        items: { select: { variantId: true, quantity: true } },
      },
    });
    if (order?.marketId !== "bd" || order.status !== "PLACED" || order.fulfillmentStatus !== "SHIPPED" ||
        order.bangladeshShipment?.status !== "REFUSED") {
      throw new OperationError("Only a refused Bangladesh parcel can be received this way.");
    }
    const prior = order.bangladeshRefusedParcelReceipt;
    if (prior) {
      if (prior.disposition !== disposition) throw new OperationError("A receipt already exists with a different stock decision. Refresh the order.");
      return prior;
    }
    const payment = order.payment;
    const prepaid = payment && (payment.method === "SSLCOMMERZ" || isManualPaymentMethod(payment.method));
    if (!((payment?.method === "COD" && payment.status === "VOIDED") || (prepaid && payment.status === "PAID"))) {
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
