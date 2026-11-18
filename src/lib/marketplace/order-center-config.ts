import type { MarketId } from "../../config/markets.ts";
import { fixtureMarketEnabled, hybridDemoMode } from "../release-config.ts";
import { bdOrderHubConfig } from "./bd-order-hub-bridge.ts";

export function orderCenterEnabled(market: MarketId) {
  if (market === "bd") return Boolean(bdOrderHubConfig());
  return hybridDemoMode() && process.env.SHOPPER_MAIL_MODE === "preview" &&
    (process.env.COMMERCE_MODE === "local" || process.env.BETTER_AUTH_URL === "https://dev.griipbuddy.com") &&
    (market === "us" || (market === "ca" && fixtureMarketEnabled()));
}
