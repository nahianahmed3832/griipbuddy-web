import { Prisma } from "../../generated/prisma/client.ts";
import { markets, type Currency } from "../../config/markets.ts";
import { allocateMinor as allocate } from "../commerce/allocate-minor.ts";
import { getDb } from "../db/client.ts";
import type { SellerOrderRange } from "./seller-order-range.ts";

export const sampleSellerCommissionBasisPoints = 1000;
const maximumStatementOrders = 5000;

export class SellerStatementRangeError extends Error {}

function emptyAmounts() {
  return {
    grossSalesMinor: 0,
    discountsMinor: 0,
    buyerShippingMinor: 0,
    collectedMinor: 0,
    remittedMinor: 0,
    courierFeesMinor: 0,
    approvedRefundsMinor: 0,
    returnsMinor: 0,
    commissionMinor: 0,
    balanceOwedMinor: 0,
    pendingMerchandiseMinor: 0,
    returnedUnits: 0,
  };
}

type StatementAmounts = ReturnType<typeof emptyAmounts>;
export type SellerStatementRow = StatementAmounts & {
  orderId: string;
  reference: string;
  createdAt: Date;
  delivery: "PENDING" | "DELIVERED" | "REFUSED" | "CANCELLED";
  collection: "PENDING" | "COLLECTED" | "VOIDED";
  remittance: "UNRECORDED" | "DISCREPANCY" | "MATCHED";
};
export type SellerStatement = {
  shop: { id: string; name: string };
  asOf: Date;
  currency: Currency;
  commissionBasisPoints: number;
  totals: StatementAmounts;
  rows: SellerStatementRow[];
};

const orderSelect = {
  id: true, reference: true, createdAt: true, status: true, fulfillmentStatus: true,
  subtotalMinor: true, discountMinor: true, deliveryMinor: true, taxMinor: true, totalMinor: true,
  bangladeshShipment: { select: { status: true } },
  parcels: { select: { status: true } },
  payment: { select: { status: true, amountMinor: true } },
  codRemittances: {
    take: 1, orderBy: { attempt: "desc" },
    select: { status: true, expectedGrossMinor: true, grossMinor: true, deductionsMinor: true, netMinor: true },
  },
  items: {
    orderBy: { id: "asc" },
    select: { id: true, marketplaceShopId: true, unitPriceMinor: true, quantity: true, lineTotalMinor: true },
  },
  cases: {
    where: { kind: { in: ["RETURN", "EXCHANGE"] }, returnReceivedAt: { not: null } },
    select: {
      refundAmountMinor: true,
      returnLines: { orderBy: { orderItemId: "asc" }, select: { orderItemId: true, quantity: true } },
    },
  },
} satisfies Prisma.OrderSelect;
type StatementOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

function merchandiseReturns(order: StatementOrder, shopId: string) {
  const items = new Map(order.items.map(item => [item.id, item]));
  const totals = { returnedUnits: 0, approvedRefundsMinor: 0, returnsMinor: 0 };
  const orderMerchandise = order.subtotalMinor - order.discountMinor;
  for (const orderCase of order.cases) {
    const lines = orderCase.returnLines.flatMap(line => {
      const item = items.get(line.orderItemId);
      if (!item) return [];
      const merchandise = Number(BigInt(item.lineTotalMinor) * BigInt(line.quantity) / BigInt(item.quantity));
      return [{ merchandise, quantity: line.quantity, owned: item.marketplaceShopId === shopId }];
    });
    const merchandise = lines.reduce((sum, line) => sum + line.merchandise, 0);
    // Match the case's original refund cap before splitting an approved partial refund by line.
    const taxMinor = orderMerchandise > 0 ? Number(BigInt(order.taxMinor) * BigInt(merchandise) / BigInt(orderMerchandise)) : 0;
    const byLineTax = allocate(taxMinor, lines.map(line => line.merchandise));
    const refundShares = allocate(orderCase.refundAmountMinor ?? 0, lines.flatMap((line, index) => [line.merchandise, byLineTax[index]]));
    lines.forEach((line, index) => {
      if (!line.owned) return;
      const returnedMerchandise = refundShares[index * 2];
      totals.returnedUnits += line.quantity;
      totals.approvedRefundsMinor += returnedMerchandise + refundShares[index * 2 + 1];
      totals.returnsMinor += returnedMerchandise;
    });
  }
  return totals;
}

function statementRow(order: StatementOrder, shopId: string): SellerStatementRow {
  const shipment = order.bangladeshShipment?.status;
  const delivered = order.status === "PLACED" && order.fulfillmentStatus === "DELIVERED" &&
    (!shipment || shipment === "DELIVERED") && order.parcels.every(parcel => parcel.status === "DELIVERED");
  const refused = shipment === "REFUSED" || order.parcels.some(parcel => parcel.status === "REFUSED" || parcel.status === "RETURNED");
  const row: SellerStatementRow = {
    ...emptyAmounts(), orderId: order.id, reference: order.reference, createdAt: order.createdAt,
    delivery: order.status === "CANCELLED" ? "CANCELLED" : refused ? "REFUSED" : delivered ? "DELIVERED" : "PENDING",
    collection: order.payment?.status === "VOIDED" ? "VOIDED" : "PENDING",
    remittance: "UNRECORDED",
  };
  if (!delivered) return row;

  const ownLineSum = (amounts: readonly number[]) => order.items.reduce((sum, item, index) =>
    item.marketplaceShopId === shopId ? sum + amounts[index] : sum, 0);
  const lineNet = order.items.map(item => item.lineTotalMinor);
  const netMerchandise = ownLineSum(lineNet);
  const shippingWeights = lineNet.some(amount => amount > 0) ? lineNet : order.items.map(item => item.quantity);
  const buyerShipping = allocate(order.deliveryMinor, shippingWeights);
  row.grossSalesMinor = ownLineSum(order.items.map(item => item.unitPriceMinor * item.quantity));
  row.discountsMinor = row.grossSalesMinor - netMerchandise;
  row.buyerShippingMinor = ownLineSum(buyerShipping);
  Object.assign(row, merchandiseReturns(order, shopId));
  const retainedMerchandise = netMerchandise - row.returnsMinor;
  row.pendingMerchandiseMinor = retainedMerchandise;

  if (order.payment?.status !== "COLLECTED") return row;
  row.collection = "COLLECTED";
  const buyerTaxes = allocate(order.taxMinor, shippingWeights);
  const charged = lineNet.map((net, index) => net + buyerShipping[index] + buyerTaxes[index]);
  const collected = allocate(order.payment.amountMinor, charged);
  row.collectedMinor = ownLineSum(collected);
  const latest = order.codRemittances[0];
  if (!latest) return row;
  row.remittance = "DISCREPANCY";
  if (latest.status !== "MATCHED" || latest.expectedGrossMinor !== order.totalMinor ||
      latest.grossMinor !== order.payment.amountMinor || latest.grossMinor !== order.totalMinor ||
      latest.grossMinor - latest.deductionsMinor !== latest.netMinor) return row;
  row.remittance = "MATCHED";
  row.courierFeesMinor = ownLineSum(allocate(latest.deductionsMinor, collected));
  row.remittedMinor = row.collectedMinor - row.courierFeesMinor;
  row.commissionMinor = Number(BigInt(retainedMerchandise) * BigInt(sampleSellerCommissionBasisPoints) / 10_000n);
  row.balanceOwedMinor = retainedMerchandise - row.commissionMinor - row.courierFeesMinor;
  row.pendingMerchandiseMinor = 0;
  return row;
}

export async function sellerStatement(shopperId: string, range: SellerOrderRange): Promise<SellerStatement | null> {
  const { marketId } = range;
  const { currency } = markets[marketId];
  return getDb().$transaction(async tx => {
    const shop = await tx.marketplaceShop.findUnique({ where: { ownerId: shopperId }, select: { id: true, name: true } });
    if (!shop) return null;
    const asOf = new Date();
    const orders = await tx.order.findMany({
      where: {
        marketId, currency, measurementTest: true,
        createdAt: { gte: range.start, lt: range.endExclusive },
        items: { some: { marketplaceShopId: shop.id } },
        payment: { method: "COD", currency },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: maximumStatementOrders + 1,
      select: orderSelect,
    });
    if (orders.length > maximumStatementOrders) {
      throw new SellerStatementRangeError("This statement includes more than 5,000 orders. Choose a shorter date range.");
    }
    const rows = orders.map(order => statementRow(order, shop.id));
    const totals = emptyAmounts();
    const amountKeys = Object.keys(totals) as (keyof StatementAmounts)[];
    for (const row of rows) {
      for (const key of amountKeys) totals[key] += row[key];
    }
    return { shop, asOf, currency, commissionBasisPoints: sampleSellerCommissionBasisPoints, totals, rows };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
