import { z } from "zod";
import { isMarketId, marketList, markets, type Currency, type MarketId } from "../../config/markets.ts";

export const commerceAuthorityId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const commerceSourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
export const commerceMarketId = z.custom<MarketId>(isMarketId);
export const commerceCurrency = z.custom<Currency>(value => marketList.some(market => market.currency === value));

const scopeInput = z.strictObject({
  authority: commerceAuthorityId,
  marketId: commerceMarketId,
  currency: commerceCurrency,
});
export type CommerceScope = z.output<typeof scopeInput>;

const entityKind = z.enum([
  "product", "variant", "offer", "stock_pool", "warehouse", "location", "bin", "lot", "reservation",
  "customer", "seller", "staff", "order", "order_line", "payment", "refund", "shipment", "outcome",
]);
const referenceInput = scopeInput.omit({ currency: true }).extend({
  kind: entityKind,
  sourceId: commerceSourceId,
});
export type CommerceReference = z.output<typeof referenceInput>;

const moneyInput = z.strictObject({ amountMinor: z.int(), currency: commerceCurrency });
export type CommerceMoney = z.output<typeof moneyInput>;

export class CommerceContractError extends Error {
  constructor(readonly code: "invalid_input" | "market_mismatch" | "forbidden" | "conflict" | "unavailable", message: string) {
    super(message);
    this.name = "CommerceContractError";
  }
}

export function bindCommerceScope(input: unknown): CommerceScope {
  const parsed = scopeInput.safeParse(input);
  if (!parsed.success) throw new CommerceContractError("invalid_input", "Invalid commerce authority, market or currency.");
  if (markets[parsed.data.marketId].currency !== parsed.data.currency) {
    throw new CommerceContractError("market_mismatch", "Currency differs from the configured market.");
  }
  return parsed.data;
}

// Callers bind authority and market from the verified service identity and record, before qualifying its local ID.
export function commerceReferenceFor(scope: CommerceScope, kind: CommerceReference["kind"], sourceId: unknown): CommerceReference {
  const parsed = referenceInput.safeParse({ authority: scope.authority, marketId: scope.marketId, kind, sourceId });
  if (!parsed.success) throw new CommerceContractError("invalid_input", "Invalid commerce record reference.");
  return parsed.data;
}

export function validateCommerceMoney(scope: CommerceScope, input: unknown): CommerceMoney {
  const parsed = moneyInput.safeParse(input);
  if (!parsed.success) throw new CommerceContractError("invalid_input", "Invalid minor amount or currency.");
  if (parsed.data.currency !== scope.currency) {
    throw new CommerceContractError("market_mismatch", "Amount currency differs from the configured market.");
  }
  return parsed.data;
}
