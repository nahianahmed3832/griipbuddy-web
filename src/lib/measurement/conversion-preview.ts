import { markets, type MarketId } from "../../config/markets.ts";
import type { CommerceOutcome } from "./outcomes.ts";
import { measurementSchemaVersion } from "./schema.ts";

export function fixtureConversionPreview(event: CommerceOutcome, marketId: MarketId) {
  if (event.schemaVersion !== measurementSchemaVersion || event.test !== true || !event.journeyId ||
      event.marketId !== marketId || event.currency !== markets[marketId].currency ||
      event.source !== "payment" || !(event.evidence === "fixture" || event.evidence === "sandbox") ||
      !/^[a-f0-9]{64}$/.test(event.id) || !/^gb-[a-f0-9]{40}$/.test(event.transactionId ?? "") ||
      event.amountMinor === null || !Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0) return null;
  const captured = event.kind === "PAYMENT_PAID" && (event.paymentMethod === "PAYPAL" || event.paymentMethod === "SSLCOMMERZ");
  const collected = event.kind === "COD_COLLECTED" && event.paymentMethod === "COD";
  if (!captured && !collected) return null;
  return {
    version: measurementSchemaVersion,
    eventId: event.id,
    transaction: event.transactionId!,
    event: captured ? "payment_captured" : "cash_collected",
    occurredAt: event.at.toISOString(),
    market: marketId,
    currency: event.currency,
    amountMinor: event.amountMinor,
  } as const;
}
