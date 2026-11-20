import { isMarketId, marketIds, type MarketId } from "../../config/markets.ts";
import { isOperatingDatabase } from "../db/local.ts";
import { marketConfiguration, marketPayment, type MarketEvidence, type MarketPaymentMethod } from "../market-config.ts";

export const checkoutMarketHeader = "x-griipbuddy-checkout-market";

export function checkoutDestination(headers: Headers, selected: MarketId): MarketId | null {
  const requested = headers.get(checkoutMarketHeader);
  return requested === null ? selected : isMarketId(requested) ? requested : null;
}

export function operatingEvidence(): MarketEvidence {
  return process.env.COMMERCE_MODE === "production" ? "production" : "sandbox";
}

export function configuredPayment(marketId: MarketId, method: MarketPaymentMethod) {
  const market = marketConfiguration(marketId);
  const mode = operatingEvidence();
  const payment = marketPayment(market, method, mode);
  if (!payment || !isOperatingDatabase()) return null;
  const fulfillment = market.fulfillment.filter(entry => entry.evidence === mode).map(entry => entry.adapter);
  const returns = market.returns.filter(entry => entry.evidence === mode).map(entry => entry.adapter);
  if (!fulfillment.length || !returns.length) return null;
  return {
    market, payment, fulfillment, returns,
    evidence: mode === "production" ? "production" as const
      : process.env.COMMERCE_MODE === "staging" && method !== "COD" ? "sandbox" as const : "fixture" as const,
  };
}

// The legacy provider API contracts omit a market. Use the uniquely configured
// adapter for old callers and callbacks. Ambiguous settings fail closed.
export function providerMarket(method: Exclude<MarketPaymentMethod, "COD">) {
  if (!isOperatingDatabase() || operatingEvidence() !== "sandbox") return undefined;
  const eligible = marketIds.filter(marketId => marketConfiguration(marketId).payments.some(entry =>
    entry.method === method && entry.evidence === "sandbox"));
  return eligible.length === 1 ? eligible[0] : undefined;
}

export function commercialTerms(operating: NonNullable<ReturnType<typeof configuredPayment>>, terms: {
  deliveryService: string; deliveryZone: string; deliveryRevision?: number; policyRevision?: number; taxBasisPoints?: number;
}) {
  const { market, payment, fulfillment, returns, evidence } = operating;
  return {
    version: 1, marketId: market.id, marketRevision: market.revision, countryCode: market.countryCode,
    currency: market.currency, priceList: market.pricing.priceList, rounding: market.pricing.rounding,
    taxTreatment: market.pricing.taxTreatment, addressAdapter: market.address.adapter,
    paymentAdapter: payment.adapter, paymentMethod: payment.method, fulfillment, returns, evidence,
    ...terms,
  };
}

export type CommercialTerms = ReturnType<typeof commercialTerms>;

export function roundedMerchandiseTax(netMinor: number, basisPoints: number) {
  return Math.floor((netMinor * basisPoints + 5_000) / 10_000);
}

export function orderHasAdapter(order: { marketId: MarketId; measurementTest: boolean | null; commercialSnapshot?: unknown },
  activity: "fulfillment" | "returns", adapter: "manual" | "steadfast") {
  const snapshot = order.commercialSnapshot;
  if (snapshot && typeof snapshot === "object" && activity in snapshot) {
    const configured = (snapshot as Record<string, unknown>)[activity];
    return Array.isArray(configured) && configured.includes(adapter);
  }
  // Older accepted orders remain operational during rollout and market pauses.
  if (adapter === "manual") return true;
  const evidence = order.measurementTest === false ? "production" : "sandbox";
  return marketConfiguration(order.marketId)[activity].some(entry => entry.adapter === adapter && entry.evidence === evidence);
}
