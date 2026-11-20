import { marketForStorefrontOrigin, resolveMarketScope } from "../market-config.ts";

export function workspaceRequestMarket(url: string) {
  const parsed = new URL(url);
  const values = parsed.searchParams.getAll("market");
  if (values.length !== 1) return null;
  const market = resolveMarketScope(values[0]);
  const routed = marketForStorefrontOrigin(parsed.origin);
  return market && (!routed || routed === market.id) ? market.id : null;
}
