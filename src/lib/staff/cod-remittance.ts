import { z } from "zod";
import type { CodRemittanceStatus, Prisma } from "../../generated/prisma/client.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { getDb } from "../db/client.ts";
import { authorize, OperationError } from "./operations.ts";

const amountMinor = z.number().int().min(0).max(2_147_483_647);
const remittanceInput = z.object({
  reference: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u),
  grossMinor: amountMinor,
  deductionsMinor: amountMinor,
  netMinor: amountMinor,
});

const codPayment = { method: "COD", currency: "BDT" } as const;
const bangladeshCod = { marketId: "bd", currency: "BDT", payment: codPayment } as const;
const eligibleDelivery = {
  status: "PLACED",
  fulfillmentStatus: "DELIVERED",
  OR: [{ bangladeshShipment: null }, { bangladeshShipment: { status: "DELIVERED" } }],
} satisfies Prisma.OrderWhereInput;

export async function recordCodRemittance(actorId: string, orderId: string, input: unknown): Promise<CodRemittanceStatus> {
  if (!uuid.safeParse(orderId).success) throw new OperationError("Order not found.");
  const parsed = remittanceInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter a remittance reference and three nonnegative BDT amounts with up to two decimal places.");
  const { grossMinor, deductionsMinor, netMinor } = parsed.data;

  return getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true, "bd");
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: orderId, ...bangladeshCod, ...eligibleDelivery },
      select: { totalMinor: true, payment: { select: { status: true, amountMinor: true } } },
    });
    if (!order?.payment || order.payment.status !== "COLLECTED") {
      throw new OperationError("Remittance requires a delivered Bangladesh COD order with collection recorded.");
    }
    const expectedGrossMinor = order.payment.amountMinor;
    if (expectedGrossMinor !== order.totalMinor) throw new OperationError("The COD payment amount differs from the order total. Review it before recording remittance.");

    const previous = await tx.codRemittance.findFirst({
      where: { orderId, ...parsed.data }, select: { status: true },
    });
    if (previous) return previous.status;
    const latest = await tx.codRemittance.findFirst({
      where: { orderId }, orderBy: { attempt: "desc" }, select: { attempt: true, status: true },
    });
    if (latest?.status === "MATCHED") throw new OperationError("The remittance for this order is already matched.");

    const status = expectedGrossMinor === grossMinor && grossMinor - deductionsMinor === netMinor ? "MATCHED" : "DISCREPANCY";
    await tx.codRemittance.create({
      data: { orderId, attempt: (latest?.attempt ?? 0) + 1, actorId, expectedGrossMinor, status, ...parsed.data },
    });
    return status;
  });
}

export const codReconciliationFilters = [
  ["awaiting-remittance", "Awaiting remittance"],
  ["awaiting-collection", "Awaiting collection"],
  ["discrepancy", "Discrepancies"],
  ["matched", "Matched remittances"],
  ["voided", "Voided COD"],
] as const;

type ReconciliationFilter = typeof codReconciliationFilters[number][0];

export function codReconciliationFilter(value: unknown): ReconciliationFilter {
  return codReconciliationFilters.find(([id]) => value === id)?.[0] ?? "awaiting-remittance";
}

const orderFilters = {
  "awaiting-remittance": {
    ...eligibleDelivery,
    payment: { ...codPayment, status: "COLLECTED" },
    codRemittances: { none: {} },
  },
  "awaiting-collection": { ...eligibleDelivery, payment: { ...codPayment, status: "AWAITING_COLLECTION" } },
  discrepancy: { codRemittances: { some: { status: "DISCREPANCY" }, none: { status: "MATCHED" } } },
  matched: { codRemittances: { some: { status: "MATCHED" } } },
  voided: { payment: { ...codPayment, status: "VOIDED" } },
} satisfies Record<ReconciliationFilter, Prisma.OrderWhereInput>;

const pageSize = 30;
export async function listCodReconciliation(actorId: string, filter: ReconciliationFilter, page: number) {
  const db = getDb();
  await authorize(db, actorId, true, "bd");
  const rows = await db.order.findMany({
    where: { ...bangladeshCod, ...orderFilters[filter] },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: {
      id: true, reference: true, carrier: true, trackingReference: true, status: true,
      fulfillmentStatus: true, totalMinor: true,
      bangladeshShipment: { select: { status: true } },
      codRemittances: {
        take: 1, orderBy: { attempt: "desc" },
        select: { netMinor: true, reference: true },
      },
    },
  });
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
}

export async function codReconciliationOrder(actorId: string, orderId: string) {
  const db = getDb();
  await authorize(db, actorId, true, "bd");
  if (!uuid.safeParse(orderId).success) return null;
  const order = await db.order.findFirst({
    where: { id: orderId, ...bangladeshCod },
    select: {
      id: true, reference: true, carrier: true, trackingReference: true, status: true,
      fulfillmentStatus: true, totalMinor: true,
      bangladeshShipment: { select: { status: true } },
      payment: { select: { status: true, amountMinor: true, collectedAt: true } },
      codRemittances: { orderBy: { attempt: "desc" }, include: { actor: { select: { name: true } } } },
    },
  });
  if (!order?.payment) return null;
  const eligible = order.status === "PLACED" && order.fulfillmentStatus === "DELIVERED"
    && (!order.bangladeshShipment || order.bangladeshShipment.status === "DELIVERED");
  const canRecord = eligible && order.payment.status === "COLLECTED" && order.payment.amountMinor === order.totalMinor
    && order.codRemittances[0]?.status !== "MATCHED";
  return { ...order, payment: order.payment, eligible, canRecord };
}
