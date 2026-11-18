import { getDb } from "../db/client.ts";
import { lockFulfillmentOrder, OperationError } from "./operations.ts";
import type { DevAdminFulfillmentOperator, DevAdminOrderCommand } from "./dev-admin-order-proof.ts";

type DetailCommand = Extract<DevAdminOrderCommand, { action: "edit-contact" | "add-note" }>;

export function saveHybridOrderDetails(actor: DevAdminFulfillmentOperator, orderId: string, command: DetailCommand) {
  return getDb().$transaction(async tx => {
    const { order, actorId } = await lockFulfillmentOrder(tx, actor, orderId);
    if (command.action === "add-note") {
      const prior = await tx.auditEvent.findFirst({
        where: { target: orderId, action: "FULFILLMENT_CHANGED", changes: { path: ["adminNoteKey"], equals: command.key } },
      });
      if (!prior) await tx.auditEvent.create({ data: { actorId, action: "FULFILLMENT_CHANGED", target: orderId,
        changes: { adminNoteKey: command.key, adminNote: command.note } } });
      return;
    }

    if (order.status !== "PLACED" || !["UNFULFILLED", "PACKING", "READY_TO_SHIP"].includes(order.fulfillmentStatus)) {
      throw new OperationError("Contact details can only be changed before dispatch.");
    }
    if (order.updatedAt.toISOString() !== command.revision) {
      throw new OperationError("This order changed. Refresh the page and try again.");
    }
    await tx.order.update({ where: { id: orderId }, data: { customerName: command.name, phone: command.phone, address: command.address } });
    await tx.auditEvent.create({ data: { actorId, action: "FULFILLMENT_CHANGED", target: orderId,
      changes: { adminContactUpdated: true } } });
  });
}
