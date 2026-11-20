import { allocateMinor } from "../commerce/allocate-minor.ts";
import { storeShop } from "./constants.ts";

export type FinanceLine = {
  id: string;
  marketplaceShopId: string | null;
  currency: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  taxAllocatedMinor: number | null;
  deliveryAllocatedMinor: number | null;
};

export type UnitSlice = { orderItemId: string; quantity: number; settlementUnitOffset: number | null };

export class SellerFinanceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
export function financeAssert(condition: unknown, message: string, status = 409): asserts condition {
  if (!condition) throw new SellerFinanceError(status, message);
}

export const sum = (values: readonly number[]) => values.reduce((total, amount) => total + amount, 0);
export const rateMinor = (amount: number, bps: number) => Number(BigInt(amount) * BigInt(bps) / 10_000n);
const count = (value: number, index: number, quantity: number) => BigInt(value) * BigInt(index) / BigInt(quantity);

export function checkedSlice(line: FinanceLine, slice: UnitSlice) {
  financeAssert(slice.orderItemId === line.id && slice.settlementUnitOffset !== null && slice.settlementUnitOffset >= 0 &&
    slice.quantity > 0 && slice.settlementUnitOffset + slice.quantity <= line.quantity, "A settlement line requires exact original unit evidence.");
  return slice.settlementUnitOffset;
}

function slicedMinor(value: number, total: number, slice: UnitSlice, offset: number) {
  return Number(count(value, offset + slice.quantity, total) - count(value, offset, total));
}

type LineAmount = { id: string; shopId: string | null; grossMinor: number; discountMinor: number; taxMinor: number;
  shippingMinor: number; merchMinor: number };
export type FinanceAmounts = {
  grossMinor: number; discountMinor: number; taxMinor: number; shippingMinor: number; commissionMinor: number;
  feeMinor: number; netMinor: number; refundMinor: number;
};
export type AccrualLine = LineAmount & { commissionMinor: number; feeMinor: number };
type OrderAmounts = { currency: string; subtotalMinor: number; discountMinor: number; taxMinor: number; deliveryMinor: number; totalMinor: number };

export function orderAmounts(order: OrderAmounts, items: readonly FinanceLine[], cancelled: readonly UnitSlice[]) {
  const lines: LineAmount[] = items.map(line => {
    financeAssert(line.currency === order.currency && line.quantity > 0 && line.taxAllocatedMinor !== null &&
      line.deliveryAllocatedMinor !== null, "The order is missing its exact original market or price allocations.");
    const grossMinor = line.unitPriceMinor * line.quantity;
    financeAssert(grossMinor >= line.lineTotalMinor && line.lineTotalMinor >= 0 && line.taxAllocatedMinor >= 0 &&
      line.deliveryAllocatedMinor >= 0, "An original order line contains an invalid allocation.");
    return { id: line.id, shopId: line.marketplaceShopId === storeShop.id ? null : line.marketplaceShopId,
      grossMinor, discountMinor: grossMinor - line.lineTotalMinor,
      merchMinor: line.lineTotalMinor, taxMinor: line.taxAllocatedMinor, shippingMinor: line.deliveryAllocatedMinor };
  });
  financeAssert(sum(lines.map(line => line.grossMinor)) === order.subtotalMinor &&
    sum(lines.map(line => line.discountMinor)) === order.discountMinor &&
    sum(lines.map(line => line.taxMinor)) === order.taxMinor && sum(lines.map(line => line.shippingMinor)) === order.deliveryMinor &&
    order.subtotalMinor - order.discountMinor + order.taxMinor + order.deliveryMinor === order.totalMinor,
  "Original line amounts do not reconcile to the order.");
  const indexed = new Map(items.map((line, index) => [line.id, { line, total: lines[index], intervals: [] as [number, number][] }]));
  for (const slice of cancelled) {
    const owned = indexed.get(slice.orderItemId);
    financeAssert(owned, "A cancellation references a different order line.");
    const { line, total, intervals } = owned;
    const offset = checkedSlice(line, slice);
    financeAssert(intervals.every(([start, end]) => offset >= end || offset + slice.quantity <= start),
      "Cancelled units overlap an earlier settled cancellation.");
    intervals.push([offset, offset + slice.quantity]);
    const gross = slicedMinor(line.unitPriceMinor * line.quantity, line.quantity, slice, offset);
    const merchandise = slicedMinor(line.lineTotalMinor, line.quantity, slice, offset);
    total.grossMinor -= gross;
    total.merchMinor -= merchandise;
    total.discountMinor -= gross - merchandise;
    total.taxMinor -= slicedMinor(line.taxAllocatedMinor!, line.quantity, slice, offset);
  }
  return lines;
}

export function chargeMinor(line: LineAmount) {
  return line.merchMinor + line.taxMinor + line.shippingMinor;
}

export function accrueLines(lines: readonly LineAmount[], policy: { commissionBps: number; processingFeeBps: number }, online: boolean) {
  const seller = lines.map(line => line.shopId ? line.merchMinor : 0);
  const charges = lines.map(chargeMinor);
  const fees = allocateMinor(online ? rateMinor(sum(charges), policy.processingFeeBps) : 0, charges);
  const commissions = allocateMinor(rateMinor(sum(seller), policy.commissionBps), seller);
  return lines.map((line, index) => ({ ...line, commissionMinor: commissions[index], feeMinor: fees[index] }));
}

export function groupSellerAmounts<T extends { shopId: string | null }>(lines: readonly T[]) {
  const result = new Map<string, T[]>();
  for (const line of lines) {
    if (!line.shopId) continue;
    const prior = result.get(line.shopId) ?? [];
    prior.push(line);
    result.set(line.shopId, prior);
  }
  return result;
}

export function summarizeAccrual(lines: readonly AccrualLine[]): FinanceAmounts {
  const grossMinor = sum(lines.map(line => line.grossMinor));
  const discountMinor = sum(lines.map(line => line.discountMinor));
  const taxMinor = sum(lines.map(line => line.taxMinor));
  const shippingMinor = sum(lines.map(line => line.shippingMinor));
  const commissionMinor = sum(lines.map(line => line.commissionMinor));
  const feeMinor = sum(lines.map(line => line.feeMinor));
  return { grossMinor, discountMinor, taxMinor, shippingMinor, commissionMinor, feeMinor, refundMinor: 0,
    netMinor: grossMinor - discountMinor + shippingMinor - commissionMinor - feeMinor };
}

export function refundLines(items: readonly FinanceLine[], saleLines: readonly AccrualLine[], slices: readonly UnitSlice[],
  amount: number, wholeCancellation: boolean) {
  const original = new Map(items.map(item => [item.id, item]));
  const sale = new Map(saleLines.map(line => [line.id, line]));
  const selected = wholeCancellation
    ? items.map(item => ({ orderItemId: item.id, settlementUnitOffset: 0, quantity: item.quantity }))
    : slices;
  const claims = selected.map(slice => {
    const item = original.get(slice.orderItemId);
    const line = sale.get(slice.orderItemId);
    financeAssert(item && line && item.taxAllocatedMinor !== null, "The confirmed refund requires its original exact line allocations.");
    const offset = checkedSlice(item, slice);
    return {
      id: line.id,
      shopId: line.shopId,
      merchandise: slicedMinor(item.lineTotalMinor, item.quantity, slice, offset),
      taxMinor: slicedMinor(item.taxAllocatedMinor, item.quantity, slice, offset),
      shippingMinor: wholeCancellation ? line.shippingMinor : 0,
      commissionCap: slicedMinor(line.commissionMinor, item.quantity, slice, offset),
    };
  });
  const weights = claims.flatMap(line => [line.merchandise, line.taxMinor, line.shippingMinor]);
  financeAssert(amount > 0 && amount <= sum(weights), "The refund exceeds eligible original amounts.");
  const allocation = allocateMinor(amount, weights);
  return claims.map((line, index) => {
    const merchandise = allocation[index * 3];
    const taxMinor = allocation[index * 3 + 1];
    const shippingMinor = allocation[index * 3 + 2];
    const commissionMinor = line.merchandise === 0 ? 0
      : Number(BigInt(line.commissionCap) * BigInt(merchandise) / BigInt(line.merchandise));
    return { id: line.id, shopId: line.shopId, merchandise, taxMinor, shippingMinor, commissionMinor,
      refundMinor: merchandise + taxMinor + shippingMinor, netMinor: -merchandise - shippingMinor + commissionMinor };
  });
}
