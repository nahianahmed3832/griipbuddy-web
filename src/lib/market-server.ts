import { cookies, headers } from "next/headers";
import { cache } from "react";
import { languageCookie, marketCookie } from "@/config/markets";
import { languageRequestHeader, marketRequestHeader } from "@/config/regional-path";
import { hybridDemoMode } from "./release-config";
import { isMarketSelectable, marketConfiguration, resolveMarketLocale, selectedMarketId } from "./market-config";

export const currentMarket = cache(async () => {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  const resolved = requestHeaders.get(marketRequestHeader);
  const marketId = selectedMarketId(isMarketSelectable(resolved) ? resolved : cookieStore.get(marketCookie)?.value,
    hybridDemoMode() ? "us" : undefined);
  const config = marketConfiguration(marketId);
  return {
    ...config,
    locale: resolveMarketLocale(config, requestHeaders.get(languageRequestHeader) ?? cookieStore.get(languageCookie)?.value,
      requestHeaders.get("accept-language")),
  };
});
