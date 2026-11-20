import type { DbReader } from "../db/client.ts";

type LineSnapshot = { quantity: number; lineTotalMinor: number; taxAllocatedMinor: number | null };
type CaseLine = { quantity: number; settlementUnitOffset: number | null; orderItem: LineSnapshot };
type MoneyOrder = {
  id: string; currency: string; subtotalMinor: number; discountMinor: number; taxMinor: number;
  payment: { amountMinor: number; currency: string; status: string } | null;
};

function minorSlice(minor: number, purchased: number, offset: number, quantity: number) {
  const value = BigInt(minor);
  const total = BigInt(purchased);
  return Number(value * BigInt(offset + quantity) / total - value * BigInt(offset) / total);
}

export function itemizedAmount(lines: readonly CaseLine[]) {
  let amount = 0;
  for (const { orderItem, quantity, settlementUnitOffset } of lines) {
    if (settlementUnitOffset === null || orderItem.taxAllocatedMinor === null ||
        quantity < 1 || settlementUnitOffset < 0 || settlementUnitOffset + quantity > orderItem.quantity) return null;
    amount += minorSlice(orderItem.lineTotalMinor, orderItem.quantity, settlementUnitOffset, quantity) +
      minorSlice(orderItem.taxAllocatedMinor, orderItem.quantity, settlementUnitOffset, quantity);
  }
  return amount;
}

export async function remainingRefundBalance(db: DbReader, order: MoneyOrder, caseId?: string) {
  const payment = order.payment;
  if (!payment || payment.currency !== order.currency || !["PAID", "COLLECTED", "REFUND_PENDING"].includes(payment.status)) return 0;
  const prior = await db.orderCase.aggregate({
    where: { orderId: order.id, ...(caseId && { id: { not: caseId } }) }, _sum: { refundAmountMinor: true },
  });
  return Math.max(0, payment.amountMinor - (prior._sum.refundAmountMinor ?? 0));
}

export async function refundableItemAmount(db: DbReader, order: MoneyOrder, lines: readonly CaseLine[]) {
  const exact = itemizedAmount(lines);
  // Historic approvals can still be reviewed with the previous merchandise/tax estimate.
  // An externally processed refund instead requires proven snapshots and unit offsets.
  const merchandise = lines.reduce((total, line) => total +
    minorSlice(line.orderItem.lineTotalMinor, line.orderItem.quantity, 0, line.quantity), 0);
  const orderMerchandise = order.subtotalMinor - order.discountMinor;
  const legacyTax = orderMerchandise > 0 ? Number(BigInt(order.taxMinor) * BigInt(merchandise) / BigInt(orderMerchandise)) : 0;
  return Math.min(exact ?? merchandise + legacyTax, await remainingRefundBalance(db, order));
}
