import type { MarketConfiguration } from "../market-config.ts";

export function clarityProject(market: MarketConfiguration) {
  if (process.env.ACQUISITION_MEASUREMENT !== "1" || market.analytics.clarity !== "optional") return;
  const id = process.env[`CLARITY_PROJECT_ID_${market.id.toUpperCase()}`] ?? process.env.CLARITY_PROJECT_ID;
  return id && /^[a-z0-9]{5,32}$/.test(id) ? id : undefined;
}
