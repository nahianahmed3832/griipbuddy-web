import { cookies } from "next/headers";
import { cache } from "react";
import type { MarketId } from "@/config/markets";
import { currentMarket } from "@/lib/market-server";
import { getDb } from "@/lib/db/client";
import { accountLanguage, accountLanguageCookie } from "./account-language";
import { getShopper } from "./auth";

export const marketAccountProfile = cache(async (shopperId: string, marketId: MarketId) =>
  getDb().shopperMarketProfile.findUnique({ where: { shopperId_marketId: { shopperId, marketId } } }));

export const currentAccountLanguage = cache(async (marketId?: MarketId) => {
  const market = marketId ?? (await currentMarket()).id;
  if (market !== "bd") return "en" as const;
  const shopper = await getShopper();
  const profile = shopper ? await marketAccountProfile(shopper.id, market) : null;
  const preference = profile?.language ?? (await cookies()).get(accountLanguageCookie)?.value;
  return accountLanguage(market, preference);
});
