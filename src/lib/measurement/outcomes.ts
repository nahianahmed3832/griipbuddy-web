import type { MarketId } from "../../config/markets.ts";
import type { CommerceEvidence, CurrencyCode, PaymentMethod, Prisma } from "../../generated/prisma/client.ts";
import type { DbReader } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { stableMeasurementId } from "./domain.ts";
import { measurementSchemaVersion, type CommerceOutcomeKind } from "./schema.ts";

export const commerceOutcomeSelect = {
  id: true, createdAt: true, updatedAt: true, cancelledAt: true, marketId: true, currency: true, measurementTest: true,
  commerceEvidence: true, contributionEvidence: true,
  fulfillmentStatus: true, totalMinor: true, subtotalMinor: true, discountMinor: true, taxMinor: true, deliveryMinor: true,
  items: { select: { productIdSnapshot: true, variantId: true, offerIdSnapshot: true,
    quantity: true, unitPriceMinor: true, unitDiscountMinor: true } },
  measurement: { select: { journeyId: true, sessionId: true, journey: { select: { test: true } } } },
  attempt: { select: {
    marketId: true, paymentMethod: true,
    measurement: { select: { marketId: true, journeyId: true, sessionId: true, journey: { select: { test: true } } } },
    paypal: { select: { captureId: true, refundId: true } },
    prepaid: { select: { bankTransactionId: true } },
  } },
  payment: { select: { method: true, status: true, currency: true, amountMinor: true, collectedAt: true, createdAt: true } },
  events: {
    where: { type: "STATUS_CHANGED", status: "DELIVERED" },
    orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true },
  },
  bangladeshShipment: { select: { events: { where: { status: "REFUSED" }, select: { recordedAt: true } } } },
  bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
  parcels: { select: {
    id: true, receivedAt: true,
    events: { where: { status: "REFUSED" }, select: { recordedAt: true } },
  } },
  cases: { where: { kind: { in: ["RETURN", "EXCHANGE"] } }, select: { id: true, createdAt: true, returnReceivedAt: true } },
  codRemittances: {
    where: { status: "MATCHED" }, take: 1,
    select: { createdAt: true, grossMinor: true, deductionsMinor: true, netMinor: true },
  },
} satisfies Prisma.OrderSelect;

type OrderOutcomeSource = Prisma.OrderGetPayload<{ select: typeof commerceOutcomeSelect }>;
export type CommerceOutcome = {
  id: string;
  schemaVersion: typeof measurementSchemaVersion;
  kind: CommerceOutcomeKind;
  at: Date;
  marketId: MarketId;
  journeyId: string | null;
  sessionId: string | null;
  transactionId: string | null;
  orderId: string | null;
  test: boolean | null;
  evidence?: CommerceEvidence | "unknown";
  source?: NativeOutcomeAdapter["source"] | "external-bridge";
  currency: CurrencyCode;
  amountMinor: number | null;
  paymentMethod: PaymentMethod | null;
  failureCode?: string;
  grossMinor?: number;
  deductionsMinor?: number;
  purchaseLines?: { productId: string; variantId: string; offerId: string; quantity: number }[];
};

export function orderMeasurement(order: OrderOutcomeSource) {
  const attempt = order.attempt.measurement;
  const validAttempt = attempt?.marketId === order.marketId && attempt.journey.test === order.measurementTest ? attempt : null;
  const direct = order.measurement?.journey.test === order.measurementTest ? order.measurement : null;
  if (!direct) return validAttempt && { journeyId: validAttempt.journeyId, sessionId: validAttempt.sessionId };
  return {
    journeyId: direct.journeyId,
    sessionId: direct.sessionId ?? (validAttempt?.journeyId === direct.journeyId ? validAttempt.sessionId : null),
  };
}

type OutcomeObservation = {
  kind: CommerceOutcomeKind;
  at: Date | null | undefined;
  reference?: string;
  amountMinor?: number;
  grossMinor?: number;
  deductionsMinor?: number;
};

type NativeOutcomeAdapter = {
  source: "order" | "payment" | "legacy-carrier" | "parcels" | "returns";
  read: (order: OrderOutcomeSource) => OutcomeObservation[];
};

const nativeOutcomeAdapters: readonly NativeOutcomeAdapter[] = [
  {
    source: "order",
    read: order => [
      { kind: "ORDER_ACCEPTED", at: order.createdAt, amountMinor: order.totalMinor },
      { kind: "ORDER_CANCELLED", at: order.cancelledAt },
      { kind: "ORDER_DELIVERED", at: order.events[0]?.createdAt },
    ],
  },
  {
    source: "payment",
    read: order => {
      const payment = order.payment;
      if (!payment || payment.currency !== order.currency) return [];
      if (payment.method === "COD" && payment.status === "COLLECTED" && payment.amountMinor > 0) {
        const remittance = order.codRemittances[0];
        return [
          { kind: "COD_COLLECTED", at: payment.collectedAt, amountMinor: payment.amountMinor },
          ...(remittance ? [{
            kind: "COD_REMITTED" as const, at: remittance.createdAt, amountMinor: remittance.netMinor,
            grossMinor: remittance.grossMinor, deductionsMinor: remittance.deductionsMinor,
          }] : []),
        ];
      }
      const { attempt } = order;
      if (attempt.marketId !== order.marketId || attempt.paymentMethod !== payment.method) return [];
      const captured = payment.method === "PAYPAL" && attempt.paypal?.captureId ||
        payment.method === "SSLCOMMERZ" && attempt.prepaid?.bankTransactionId;
      if (!captured) return [];
      const events: OutcomeObservation[] = [{ kind: "PAYMENT_PAID", at: payment.createdAt, amountMinor: payment.amountMinor }];
      if (payment.method === "PAYPAL" && payment.status === "REFUNDED" && attempt.paypal?.refundId) {
        events.push({ kind: "ORDER_REFUNDED", at: order.cancelledAt, amountMinor: payment.amountMinor });
      }
      return events;
    },
  },
  {
    source: "legacy-carrier",
    read: order => [
      { kind: "ORDER_REFUSED", at: order.bangladeshShipment?.events[0]?.recordedAt, reference: "shipment" },
      { kind: "RETURN_RECEIVED", at: order.bangladeshRefusedParcelReceipt?.receivedAt, reference: "shipment" },
    ],
  },
  {
    source: "parcels",
    read: order => order.parcels.flatMap(parcel => [
      { kind: "ORDER_REFUSED", at: parcel.events[0]?.recordedAt, reference: parcel.id },
      { kind: "RETURN_RECEIVED", at: parcel.receivedAt, reference: parcel.id },
    ]),
  },
  {
    source: "returns",
    read: order => order.cases.flatMap(orderCase => [
      { kind: "RETURN_REQUESTED", at: orderCase.createdAt, reference: orderCase.id },
      { kind: "RETURN_RECEIVED", at: orderCase.returnReceivedAt, reference: orderCase.id },
    ]),
  },
];

function outcomeEvidence(order: OrderOutcomeSource, kind: CommerceOutcomeKind) {
  const staffFixture = kind === "ORDER_DELIVERED" || kind === "ORDER_REFUSED" || kind === "ORDER_CANCELLED" ||
    kind === "RETURN_REQUESTED" || kind === "RETURN_RECEIVED" || kind === "COD_COLLECTED" || kind === "COD_REMITTED";
  return staffFixture && order.commerceEvidence === "sandbox" ? "fixture" : order.commerceEvidence ?? "unknown";
}

// The adapters read committed records. Projection stays independent of order intake.
export function projectCommerceOutcomes(order: OrderOutcomeSource, cutoff: Date): CommerceOutcome[] {
  const association = orderMeasurement(order);
  const purchaseLines = association ? order.items.flatMap(line => line.productIdSnapshot && line.offerIdSnapshot ? [{
    productId: line.productIdSnapshot, variantId: line.variantId, offerId: line.offerIdSnapshot, quantity: line.quantity,
  }] : []) : [];
  return nativeOutcomeAdapters.flatMap(adapter => adapter.read(order).flatMap(observation => {
    const { kind, at, reference, amountMinor, grossMinor, deductionsMinor } = observation;
    if (!at || +at < +order.createdAt || +at > +cutoff) return [];
    return [{
      id: stableMeasurementId(kind, order.id, ...(reference ? [reference] : [])), schemaVersion: measurementSchemaVersion, kind, at,
      marketId: order.marketId, test: order.measurementTest, evidence: outcomeEvidence(order, kind),
      source: adapter.source, currency: order.currency, amountMinor: amountMinor ?? null,
      orderId: order.id, transactionId: `gb-${stableMeasurementId("transaction", order.id).slice(0, 40)}`,
      journeyId: association?.journeyId ?? null, sessionId: association?.sessionId ?? null,
      paymentMethod: order.payment?.method ?? null, grossMinor, deductionsMinor,
      ...((kind === "ORDER_ACCEPTED" || kind === "PAYMENT_PAID") && purchaseLines.length && { purchaseLines }),
    }];
  }));
}

export async function failedPaymentAttempts(db: DbReader, input: {
  marketId: MarketId; test: boolean; fromAt: Date; until: Date; take: number; journeyIds?: string[];
}): Promise<CommerceOutcome[]> {
  // The two native online payment integrations only connect to sandboxes.
  if (!input.test || input.journeyIds?.length === 0) return [];
  const { marketId, fromAt, until, take, journeyIds } = input;
  const options = (paymentMethod: "PAYPAL" | "SSLCOMMERZ") => ({
    where: { providerFailedAt: { gte: fromAt, lt: until }, attempt: { marketId, paymentMethod,
      OR: [{ commerceEvidence: null }, { commerceEvidence: { not: "production" as const } }],
      ...(journeyIds && { measurement: { marketId, journeyId: { in: journeyIds }, journey: { test: true } } }),
    } },
    orderBy: { providerFailedAt: "asc" as const }, take,
    select: {
      attemptId: true, providerFailedAt: true, providerFailureCode: true,
      attempt: { select: {
        commerceEvidence: true,
        measurement: { select: { marketId: true, journeyId: true, sessionId: true, journey: { select: { test: true } } } },
        order: { select: { id: true } },
      } },
    } as const,
  });
  const payments = [
    { method: "PAYPAL", read: () => db.payPalCheckout.findMany(options("PAYPAL")) },
    { method: "SSLCOMMERZ", read: () => db.prepaidCheckout.findMany(options("SSLCOMMERZ")) },
  ] as const;
  const result: CommerceOutcome[] = [];
  for (const { method: paymentMethod, read } of payments) {
    for (const { attemptId, providerFailedAt, providerFailureCode, attempt } of await read()) {
      if (!providerFailedAt || !providerFailureCode) continue;
      const association = attempt.measurement?.marketId === marketId && attempt.measurement.journey.test ? attempt.measurement : null;
      const orderId = attempt.order?.id ?? null;
      result.push({
        id: stableMeasurementId("PAYMENT_FAILED", paymentMethod, attemptId), schemaVersion: measurementSchemaVersion, kind: "PAYMENT_FAILED",
        at: providerFailedAt, marketId, test: true, currency: marketConfiguration(marketId).currency, amountMinor: null,
        evidence: attempt.commerceEvidence ?? "unknown", source: "payment",
        orderId, transactionId: orderId ? `gb-${stableMeasurementId("transaction", orderId).slice(0, 40)}` : null,
        journeyId: association?.journeyId ?? null, sessionId: association?.sessionId ?? null,
        paymentMethod, failureCode: providerFailureCode,
      });
    }
  }
  return result.sort((a, b) => +a.at - +b.at || a.id.localeCompare(b.id)).slice(0, take);
}
