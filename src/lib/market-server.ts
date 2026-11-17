import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getMarket, isStorefrontMarketId, marketCookie, type MarketId } from "@/config/markets";
import { marketRequestHeader } from "@/config/regional-path";
import { shopperIdentityDirectory } from "./marketplace/identity-directory";
import { fixtureMarketEnabled, hybridDemoMode } from "./release-config";

export function storefrontMarketAllowed(value: unknown): value is MarketId {
  const local = shopperIdentityDirectory()?.localMarket;
  return isStorefrontMarketId(value, fixtureMarketEnabled()) && (!local || local === value);
}

export const currentMarket = cache(async () => {
  const registered = shopperIdentityDirectory()?.localMarket;
  if (registered) return getMarket(registered);
  const saved = (await cookies()).get(marketCookie)?.value;
  const candidate = (await headers()).get(marketRequestHeader) ?? saved;
  return getMarket(isStorefrontMarketId(candidate, fixtureMarketEnabled()) ? candidate : hybridDemoMode() ? "us" : undefined);
});
