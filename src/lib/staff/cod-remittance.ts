import { z } from "zod";
import type { CodRemittanceStatus, Prisma } from "../../generated/prisma/client.ts";
import { defaultMarketId, markets, type MarketId } from "../../config/markets.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { parcelWasRefused } from "../commerce/parcel-tracking.ts";
import { getDb } from "../db/client.ts";
import { authorize, OperationError } from "./operations.ts";

const amountMinor = z.number().int().min(0).max(2_147_483_647);
const remittanceInput = z.object({
  reference: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u),
  grossMinor: amountMinor,
  deductionsMinor: amountMinor,
  netMinor: amountMinor,
});

const codPayment = { method: "COD" } as const;
function codScope(marketId: MarketId) {
  const { currency } = markets[marketId];
  return { marketId, currency, payment: { ...codPayment, currency } };
}
const eligibleDelivery = {
  status: "PLACED",
  fulfillmentStatus: "DELIVERED",
  OR: [{ bangladeshShipment: null }, { bangladeshShipment: { status: "DELIVERED" } }],
  parcels: { none: { status: { not: "DELIVERED" } } },
} satisfies Prisma.OrderWhereInput;
const failedParcel = { status: { in: ["REFUSED", "RETURNED"] } } satisfies Prisma.OrderParcelWhereInput;

export async function recordCodRemittance(actorId: string, orderId: string, input: unknown): Promise<CodRemittanceStatus> {
  if (!uuid.safeParse(orderId).success) throw new OperationError("Order not found.");
  const parsed = remittanceInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Enter a remittance reference and three nonnegative amounts in the order currency.");
  const { grossMinor, deductionsMinor, netMinor } = parsed.data;

  return getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: orderId, payment: codPayment, ...eligibleDelivery },
      select: { currency: true, totalMinor: true, payment: { select: { status: true, amountMinor: true, currency: true } } },
    });
    if (!order?.payment || order.payment.status !== "COLLECTED" || order.payment.currency !== order.currency) {
      throw new OperationError("Remittance requires a delivered COD order with collection recorded in the order currency.");
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
  ["awaiting-delivery", "Awaiting delivery"],
  ["awaiting-collection", "Awaiting collection"],
  ["awaiting-remittance", "Awaiting remittance"],
  ["parcel-review", "Parcel review"],
  ["discrepancy", "Discrepancies"],
  ["matched", "Matched remittances"],
  ["voided", "Voided COD"],
] as const;

type ReconciliationFilter = typeof codReconciliationFilters[number][0];

export function codReconciliationFilter(value: unknown): ReconciliationFilter {
  return codReconciliationFilters.find(([id]) => value === id)?.[0] ?? "awaiting-remittance";
}

const orderFilters = {
  "awaiting-delivery": { status: "PLACED", NOT: eligibleDelivery, parcels: { none: failedParcel }, payment: { ...codPayment, status: "AWAITING_COLLECTION" } },
  "parcel-review": { status: "PLACED", parcels: { some: failedParcel }, payment: { ...codPayment, status: "AWAITING_COLLECTION" } },
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

const deliveryHistoryFields = {
  bangladeshShipment: { select: { status: true, statusUpdatedAt: true } },
  parcels: { select: { status: true } },
  payment: { select: { status: true, amountMinor: true, currency: true, collectedAt: true } },
  events: {
    where: { type: "STATUS_CHANGED", status: "DELIVERED" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { createdAt: true },
  },
} satisfies Prisma.OrderSelect;

function withDeliveryDate<T extends Prisma.OrderGetPayload<{ select: typeof deliveryHistoryFields }>>(order: T) {
  const { bangladeshShipment, events, ...summary } = order;
  const deliveredAt = bangladeshShipment
    ? (bangladeshShipment.status === "DELIVERED" ? bangladeshShipment.statusUpdatedAt : null)
    : (events[0]?.createdAt ?? null);
  const parcelReview = order.payment?.status === "AWAITING_COLLECTION" && order.parcels.some(parcelWasRefused);
  return { ...summary, bangladeshShipment, deliveredAt, parcelReview };
}

export async function summarizeCodReconciliation(actorId: string, marketId: MarketId = defaultMarketId) {
  const db = getDb();
  await authorize(db, actorId, true);
  const scope = codScope(marketId);
  const deliveredOrders = { ...scope, ...eligibleDelivery };
  const collectedPayments = { ...scope.payment, status: "COLLECTED" } as const;
  const [delivered, collected, received] = await db.$transaction([
    db.order.aggregate({ where: deliveredOrders, _count: true, _sum: { totalMinor: true } }),
    db.payment.aggregate({ where: { ...collectedPayments, order: deliveredOrders }, _count: true, _sum: { amountMinor: true } }),
    db.codRemittance.aggregate({
      where: { status: "MATCHED", order: { ...deliveredOrders, payment: collectedPayments } },
      _count: true, _sum: { netMinor: true },
    }),
  ], { isolationLevel: "RepeatableRead" });
  // Each order has at most one matched remittance, enforced by the database.
  return {
    delivered: { orders: delivered._count, amountMinor: delivered._sum.totalMinor ?? 0 },
    collected: { orders: collected._count, amountMinor: collected._sum.amountMinor ?? 0 },
    received: { orders: received._count, amountMinor: received._sum.netMinor ?? 0 },
  };
}

const pageSize = 30;
export async function listCodReconciliation(actorId: string, filter: ReconciliationFilter, page: number,
  marketId: MarketId = defaultMarketId) {
  const db = getDb();
  await authorize(db, actorId, true);
  const rows = await db.order.findMany({
    where: { AND: [codScope(marketId), orderFilters[filter]] },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: {
      id: true, reference: true, carrier: true, trackingReference: true, status: true,
      fulfillmentStatus: true, totalMinor: true,
      ...deliveryHistoryFields,
      codRemittances: {
        take: 1, orderBy: { attempt: "desc" },
        select: { status: true, netMinor: true, reference: true, createdAt: true },
      },
    },
  });
  return { rows: rows.slice(0, pageSize).map(withDeliveryDate), hasNext: rows.length > pageSize };
}

export async function codReconciliationOrder(actorId: string, orderId: string) {
  const db = getDb();
  await authorize(db, actorId, true);
  if (!uuid.safeParse(orderId).success) return null;
  const order = await db.order.findFirst({
    where: { id: orderId, payment: codPayment },
    select: {
      id: true, reference: true, carrier: true, trackingReference: true, status: true,
      fulfillmentStatus: true, totalMinor: true, marketId: true, currency: true,
      ...deliveryHistoryFields,
      codRemittances: { orderBy: { attempt: "desc" }, include: { actor: { select: { name: true } } } },
    },
  });
  if (!order?.payment || order.payment.currency !== order.currency) return null;
  const eligible = order.status === "PLACED" && order.fulfillmentStatus === "DELIVERED"
    && (!order.bangladeshShipment || order.bangladeshShipment.status === "DELIVERED")
    && order.parcels.every(parcel => parcel.status === "DELIVERED");
  const canRecord = eligible && order.payment.status === "COLLECTED" && order.payment.amountMinor === order.totalMinor
    && order.codRemittances[0]?.status !== "MATCHED";
  return { ...withDeliveryDate(order), payment: order.payment, eligible, canRecord };
}
