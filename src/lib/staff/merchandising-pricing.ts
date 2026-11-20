import { markets, type MarketId } from "../../config/markets.ts";
import type { VariantInput } from "./catalog-input.ts";
import { costs, type CostScenario } from "./merchandising-input.ts";

function convert(minor: number, rate: string) {
  const [integer, decimal = ""] = rate.split(".");
  const scale = 10n ** BigInt(decimal.length);
  const numerator = BigInt(minor) * BigInt(integer + decimal);
  const rounded = (numerator + scale / 2n) / scale;
  return rounded > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 2)) ? null : Number(rounded);
}

export function priceWorksheet(variant: VariantInput, market: MarketId, input?: CostScenario, now = new Date()) {
  const { currency } = markets[market];
  const selling = variant.offers.find((offer) => offer.marketId === market && offer.currency === currency)?.amountMinor ?? null;
  const unknown: string[] = [];
  if (selling === null) unknown.push("Proposed selling price");
  if (!input) unknown.push("Order quantity");
  const units = input?.quantity ?? null;
  const revenue = selling !== null && units !== null ? selling * units : null;
  const product = input?.productCost;
  const exchange = input?.exchange;
  const conversion = product && product.currency !== currency && exchange?.from === product.currency && exchange.to === currency
    && exchange.observedOn <= now.toISOString().slice(0, 10) ? exchange : undefined;
  let convertedCost = null;
  if (!product) unknown.push("Supplied unit product cost and evidence");
  else if (product.currency !== currency && !conversion) unknown.push("Dated exchange rate and source");
  else if (units !== null) {
    convertedCost = conversion ? convert(product.minor * units, conversion.rate) : product.minor * units;
    if (convertedCost === null) unknown.push("Converted purchase cost within the supported monetary range");
  }
  const direct = costs.map((type) => ({ type, minor: input?.direct[type]?.minor ?? null, evidence: input?.direct[type]?.evidence }));
  for (const item of direct) if (item.minor === null) unknown.push(item.type + " cost for this order");
  const deductions = direct.reduce((sum, row) => sum + (row.minor ?? 0), convertedCost ?? 0);
  const contribution = unknown.length || revenue === null ? null : revenue - deductions;
  return { market, currency, sku: variant.sku, selling, units, revenue, product, convertedCost, direct, conversion, unknown, contribution };
}
