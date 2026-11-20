import { marketIds, type MarketId } from "@/config/markets";
import { marketConfiguration } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";

export async function orderTrackingDisplayPreferences() {
  const { locale } = await currentMarket();
  const timeZones = Object.fromEntries(marketIds.map(id => [id, marketConfiguration(id).timeZone])) as Record<MarketId, string>;
  return { locale, timeZones };
}
