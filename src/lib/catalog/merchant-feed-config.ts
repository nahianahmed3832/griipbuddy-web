import type { MarketId } from "../../config/markets.ts";
import { hybridDemoMode, productionMode, productionOrigin } from "../release-config.ts";
import type { MerchantFeedSettings } from "./merchant-feed.ts";

export function devLiveBangladeshFeed() {
  return process.env.COMMERCE_MODE === "staging" && hybridDemoMode();
}

export function merchantFeedSettings(marketId: MarketId): MerchantFeedSettings {
  const configured = productionMode() ? productionOrigin : process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3100";
  const origin = new URL(configured);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error("The storefront feed needs a configured HTTP(S) origin.");
  }
  return { marketId, origin: origin.origin, regional: hybridDemoMode(),
    ...(marketId === "bd" && devLiveBangladeshFeed() && { channelUrl: "https://griipbuddy.com/bd" }),
  };
}
