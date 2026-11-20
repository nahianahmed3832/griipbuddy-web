import { isOperatingDatabase } from "../db/local.ts";
import { marketplaceMode, orderIntakeOpen } from "../release-config.ts";
import { configuredPayment, providerMarket } from "./market-commerce.ts";
import type { MarketId } from "../../config/markets.ts";

export function prepaidConfig(marketId: MarketId | undefined = providerMarket("SSLCOMMERZ")) {
  if (!marketId || marketId !== providerMarket("SSLCOMMERZ") || !marketplaceMode() || !isOperatingDatabase()) return null;
  const storeId = process.env.MARKETPLACE_SSLCOMMERZ_STORE_ID?.trim();
  const password = process.env.MARKETPLACE_SSLCOMMERZ_STORE_PASSWORD?.trim();
  const origin = process.env.BETTER_AUTH_URL?.trim();
  if (!storeId || !password || !origin) return null;
  return { storeId, password, origin, marketId };
}

export function prepaidAvailable(marketId: MarketId | undefined = providerMarket("SSLCOMMERZ")) {
  const config = prepaidConfig(marketId);
  return Boolean(config && configuredPayment(config.marketId, "SSLCOMMERZ")) && orderIntakeOpen();
}
