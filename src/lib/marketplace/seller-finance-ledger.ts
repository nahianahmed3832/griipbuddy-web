import type { Prisma } from "../../generated/prisma/client.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { allocateMinor } from "../commerce/allocate-minor.ts";
import {
  accrueLines, chargeMinor, financeAssert, groupSellerAmounts, orderAmounts, refundLines, sum, summarizeAccrual,
} from "./seller-finance-money.ts";

export type FinanceDb = Prisma.TransactionClient;
export const financeScope = (marketId: MarketId) => ({ marketId, currency: markets[marketId].currency });
export const settlementOrderLock = (db: FinanceDb, orderId: string) =>
  db.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid FOR UPDATE`;
export const financeLock = (db: FinanceDb, marketId: MarketId, shopId: string) =>
  db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`seller-finance:${marketId}:${shopId}`}), 84)`;

const orderData = {
  items: { orderBy: { id: "asc" } },
  payment: true,
  parcels: { where: { cancelledAt: null }, select: { status: true } },
  bangladeshShipment: { select: { status: true } },
  codRemittances: { where: { status: "MATCHED" }, orderBy: { attempt: "desc" }, take: 1 },
  sellerFinanceFunding: true,
  attempt: { select: {
    paypal: true, prepaid: true,
    providerPaymentEvents: { where: { outcome: { in: ["PAID", "PROCESSED"] } }, select: {
      provider: true, accountKey: true, marketId: true, eventType: true, providerReference: true,
      currency: true, amountMinor: true, processedAt: true, outcome: true,
    } },
  } },
  cases: { orderBy: { id: "asc" }, include: { refund: true, returnLines: { orderBy: { orderItemId: "asc" } } } },
} satisfies Prisma.OrderInclude;
type SettlementOrder = Prisma.OrderGetPayload<{ include: typeof orderData }>;

export async function loadSettlementOrder(db: FinanceDb, marketId: MarketId, orderId: string) {
  const order = await db.order.findFirst({ where: {
    id: orderId, ...financeScope(marketId), measurementTest: true, commerceEvidence: { in: ["fixture", "sandbox"] },
  }, include: orderData });
  financeAssert(order, "The synthetic order is unavailable in this market.", 404);
  return order;
}

function matchedProviderCapture(order: SettlementOrder) {
  const session = order.attempt;
  const paypal = session.paypal;
  const prepaid = session.prepaid;
  const payment = order.payment;
  if (!payment || payment.method === "COD") return null;
  const paypalCapture = payment.method === "PAYPAL" && paypal?.state === "COMPLETED" && paypal.captureId;
  const prepaidCapture = payment.method === "SSLCOMMERZ" && prepaid?.state === "PAID" && prepaid.bankTransactionId;
  const reference = paypalCapture || prepaidCapture;
  const account = paypalCapture ? paypal?.providerAccountKey : prepaid?.providerAccountKey;
  const amount = paypalCapture ? paypal?.expectedAmountMinor : prepaid?.expectedAmountMinor;
  const eventType = paypalCapture ? "CAPTURE_VERIFIED" : "PAYMENT_VERIFIED";
  if (!reference || !account || amount !== order.totalMinor || payment.amountMinor !== order.totalMinor) return null;
  return session.providerPaymentEvents.find(event => event.provider === payment.method && event.accountKey === account &&
    event.providerReference === reference && event.eventType === eventType && event.outcome === "PAID" &&
    event.marketId === order.marketId && event.currency === order.currency && event.amountMinor === order.totalMinor &&
    !!event.processedAt) ?? null;
}

export function settlementPayment(order: SettlementOrder) {
  const payment = order.payment;
  if (!payment || payment.currency !== order.currency) return null;
  if (payment.method === "COD") {
    if (order.status !== "PLACED" || order.fulfillmentStatus !== "DELIVERED" || payment.status !== "COLLECTED" || !payment.collectedAt ||
      order.parcels.some(parcel => parcel.status !== "DELIVERED") ||
      (order.bangladeshShipment && order.bangladeshShipment.status !== "DELIVERED")) return null;
    return { at: payment.collectedAt, online: false };
  }
  const capture = matchedProviderCapture(order);
  if (!capture?.processedAt || !["PAID", "REFUND_PENDING", "REFUNDED"].includes(payment.status)) return null;
  return { at: capture.processedAt, online: true };
}

function confirmedRefunds(order: SettlementOrder) {
  const payment = order.payment!;
  const paypal = order.attempt.paypal;
  const cases = order.cases.flatMap(orderCase => {
    const { refund, returnLines } = orderCase;
    if (!refund || refund.state !== "CONFIRMED") return [];
    financeAssert(refund.currency === order.currency && refund.method === payment.method && refund.confirmedAt &&
      refund.providerRefundId && refund.amountMinor === orderCase.refundAmountMinor && !!paypal?.providerAccountKey &&
      order.attempt.providerPaymentEvents.some(event =>
        event.provider === payment.method && event.accountKey === paypal.providerAccountKey &&
        event.providerReference === refund.providerRefundId && event.eventType === "CASE_REFUND_CONFIRMED" &&
        event.outcome === "PROCESSED" && event.marketId === order.marketId && event.currency === order.currency &&
        event.amountMinor === refund.amountMinor && !!event.processedAt),
    "Confirmed refunds require their authenticated original payment and case evidence.");
    const whole = !returnLines.length && orderCase.kind === "CANCEL" && order.status === "CANCELLED" &&
      refund.amountMinor === payment.amountMinor;
    return [{ id: orderCase.id, amount: refund.amountMinor, at: refund.confirmedAt, lines: returnLines, whole }];
  });
  const wholeProviderRefund = payment.method === "PAYPAL" && payment.status === "REFUNDED" && order.status === "CANCELLED" &&
    order.cancelledAt && paypal?.refundId && paypal.refundStartedAt && paypal.refundActorId;
  if (wholeProviderRefund && order.cancelledAt) {
    financeAssert(!cases.length, "This order contains conflicting refund authorities.");
    return [{ id: `whole-order:${order.id}`, amount: payment.amountMinor, at: order.cancelledAt, lines: [], whole: true }];
  }
  const total = sum(cases.map(orderCase => orderCase.amount));
  financeAssert(total <= payment.amountMinor && (payment.status !== "REFUNDED" || total === payment.amountMinor),
    "The original payment refund requires review before settlement.");
  return cases.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
}

function fundingSource(order: SettlementOrder, collected: number, online: boolean) {
  if (online) return order.sellerFinanceFunding && {
    id: order.sellerFinanceFunding.operationId,
    at: order.sellerFinanceFunding.createdAt, fee: 0,
  };
  const [remittance] = order.codRemittances;
  if (!remittance) return null;
  financeAssert(remittance.expectedGrossMinor === collected && remittance.grossMinor === collected &&
    remittance.netMinor === remittance.grossMinor - remittance.deductionsMinor,
  "Matched remittance must reconcile against the actual recorded COD collection.");
  return { id: `cod:${order.id}:${remittance.attempt}`, at: remittance.createdAt, fee: remittance.deductionsMinor };
}

export async function postOrderSettlement(db: FinanceDb, order: SettlementOrder, actorId: string) {
  const paid = settlementPayment(order);
  if (!paid) return { orderId: order.id, state: "AWAITING_PAYMENT" as const, posted: 0 };
  const scope = financeScope(order.marketId);
  const prior = await db.sellerFinanceEntry.findFirst({ where: { orderId: order.id, ...scope, kind: "ACCRUAL" },
    select: { policy: true } });
  const policy = prior?.policy ?? await db.sellerFinancePolicy.findFirst({
    where: { ...scope, effectiveAt: { lte: order.createdAt } }, orderBy: { version: "desc" },
  });
  financeAssert(policy, "This order predates an effective synthetic finance policy.");
  const cancelled = paid.online ? [] : order.cases.flatMap(orderCase =>
    orderCase.kind === "CANCEL" && orderCase.status === "RESOLVED" && orderCase.cancellationAppliedAt ? orderCase.returnLines : []);
  const saleLines = accrueLines(orderAmounts(order, order.items, cancelled), policy, paid.online);
  const weights = saleLines.map(chargeMinor);
  const collected = sum(weights);
  financeAssert(collected === order.payment?.amountMinor, "Saved line amounts do not reconcile to the original payment.");
  const shopLines = groupSellerAmounts(saleLines);
  financeAssert(shopLines.size > 0, "The order has no immutable marketplace seller lines.");
  for (const shopId of [...shopLines.keys()].sort()) await financeLock(db, order.marketId, shopId);
  const existing = await db.sellerFinanceEntry.findMany({ where: { orderId: order.id, ...scope }, select: {
    shopId: true, kind: true, sourceId: true, pendingDelta: true, heldDelta: true, availableDelta: true,
  } });
  const settlements: Prisma.SellerFinanceEntryCreateManyInput[] = [];
  const funding = fundingSource(order, collected, paid.online);
  const fundTime = funding && new Date(funding.at.getTime() + policy.holdDays * 86_400_000);
  const canRelease = fundTime && fundTime <= new Date();
  const fees = funding ? allocateMinor(funding.fee, weights) : [];
  const feesByLine = new Map(saleLines.map((line, index) => [line.id, fees[index] ?? 0]));
  const refunds = confirmedRefunds(order).flatMap(refund =>
    [...groupSellerAmounts(refundLines(order.items, saleLines, refund.lines, refund.amount, refund.whole))]
      .map(([shopId, lines]) => ({ shopId, source: refund.id, at: refund.at, lines })));
  for (const [shopId, lines] of shopLines) {
    const prior = existing.filter(row => row.shopId === shopId);
    const has = (kind: Prisma.SellerFinanceEntryCreateManyInput["kind"], sourceId?: string) =>
      prior.some(row => row.kind === kind && (sourceId === undefined || row.sourceId === sourceId));
    const seed = { ...scope, shopId, orderId: order.id, policyId: policy.id };
    let pending = sum(prior.map(row => row.pendingDelta));
    let held = sum(prior.map(row => row.heldDelta));
    const previouslyReleased = has("RELEASE");
    const previouslyFunded = has("HOLD");
    if (!has("ACCRUAL")) {
      const amounts = summarizeAccrual(lines);
      settlements.push({ ...seed, ...amounts, kind: "ACCRUAL", sourceId: order.id, sourceAt: paid.at,
        pendingDelta: amounts.netMinor, lineEffects: lines });
      pending += amounts.netMinor;
    }
    for (const refund of refunds) {
      if (refund.shopId !== shopId || has("REFUND", refund.source)) continue;
      const netMinor = sum(refund.lines.map(line => line.netMinor));
      settlements.push({ ...seed, kind: "REFUND", sourceId: refund.source, sourceAt: refund.at,
        commissionMinor: -sum(refund.lines.map(line => line.commissionMinor)),
        taxMinor: -sum(refund.lines.map(line => line.taxMinor)), shippingMinor: -sum(refund.lines.map(line => line.shippingMinor)),
        netMinor, refundMinor: sum(refund.lines.map(line => line.refundMinor)), lineEffects: refund.lines,
        ...(previouslyReleased ? { availableDelta: netMinor } : previouslyFunded ? { heldDelta: netMinor } : { pendingDelta: netMinor }),
      });
      if (previouslyFunded && !previouslyReleased) held += netMinor;
      if (!previouslyFunded) pending += netMinor;
    }
    if (funding && !previouslyFunded) {
      const feeMinor = sum(lines.map(line => feesByLine.get(line.id) ?? 0));
      settlements.push({ ...seed, kind: "HOLD", sourceId: funding.id, sourceAt: funding.at, feeMinor, netMinor: -feeMinor,
        pendingDelta: -pending, heldDelta: pending - feeMinor });
      held += pending - feeMinor;
    }
    if (funding && canRelease && !previouslyReleased) {
      settlements.push({ ...seed, kind: "RELEASE", sourceId: funding.id, sourceAt: fundTime,
        heldDelta: -held, availableDelta: held });
    }
  }
  await db.sellerFinanceEntry.createMany({ data: settlements });
  await db.sellerFinanceAudit.createMany({ data: settlements.map(entry => ({
    ...scope, shopId: entry.shopId, recordId: order.id, actorId, actorKind: "staff", action: `ENTRY_${entry.kind}`,
    details: { sourceId: entry.sourceId, policyVersion: policy.version, netMinor: entry.netMinor ?? 0 },
  })) });
  return { orderId: order.id, state: canRelease ? "AVAILABLE" as const : funding ? "HELD" as const : "AWAITING_FUNDS" as const,
    policyVersion: policy.version, posted: settlements.length };
}
