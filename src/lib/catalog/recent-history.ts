import { marketIds, type MarketId } from "../../config/markets";
import { storefrontBasePath } from "../../config/storefront-path";

const prefix = `griipbuddy:recent${storefrontBasePath}`;
export const recentHistoryKey = (market: MarketId, scope: string) => `${prefix}:${market}:${scope}`;
export const recentHistoryChanged = "griipbuddy-recent-changed";

export function clearRecentHistory() {
  try {
    localStorage.removeItem(prefix);
    for (const market of marketIds) {
      const marketPrefix = `${prefix}:${market}`;
      localStorage.removeItem(marketPrefix);
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith(`${marketPrefix}:`)) localStorage.removeItem(key);
      }
    }
    window.dispatchEvent(new Event(recentHistoryChanged));
  } catch { /* Browsing works when storage is unavailable. */ }
}
