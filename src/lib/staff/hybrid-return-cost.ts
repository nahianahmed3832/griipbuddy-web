import { getDb } from "../db/client.ts";
import { lockFulfillmentOrder, OperationError } from "./operations.ts";
import { returnCostCommand, type DevAdminFulfillmentOperator } from "./dev-admin-order-proof.ts";

export async function recordHybridReturnCost(actor: DevAdminFulfillmentOperator, orderId: string, input: unknown) {
  if (!actor.canReturn || !actor.canRecordReturnCost) throw new OperationError("Access denied.", 403);
  const parsed = returnCostCommand.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter the returned purchase cost and a purchase or lot reference.");
  const { caseId, amountMinor, evidence } = parsed.data;

  return getDb().$transaction(async tx => {
    const { actorId } = await lockFulfillmentOrder(tx, actor, orderId, { returns: true, bangladeshOnly: true });
    const receipt = caseId
      ? await tx.orderCase.findFirst({
          where: { id: caseId, orderId, kind: "RETURN", returnReceivedAt: { not: null },
            returnDisposition: "RESTOCK", returnLines: { some: { quantity: { gt: 0 } } } },
          select: { returnCost: true },
        })
      : await tx.bangladeshRefusedParcelReceipt.findFirst({
          where: { orderId, disposition: "RESTOCK", restockedUnits: { gt: 0 } },
          select: { returnCost: true },
        });

    if (!receipt) throw new OperationError("Return cost needs a recorded restock receipt.", 409);
    if (receipt.returnCost) {
      const saved = receipt.returnCost;
      if (saved.amountMinor !== amountMinor || saved.evidenceReference !== evidence) {
        throw new OperationError("This receipt already has a recorded purchase cost.", 409);
      }
      return;
    }

    await tx.hybridReturnCost.create({
      data: { ...(caseId ? { caseId } : { refusedOrderId: orderId }), amountMinor, evidenceReference: evidence },
    });
    await tx.auditEvent.create({ data: {
      actorId, action: "FULFILLMENT_CHANGED", target: orderId,
      changes: { returnCostRecorded: true, caseId: caseId ?? null, amountMinor, evidenceReference: evidence },
    } });
  });
}
