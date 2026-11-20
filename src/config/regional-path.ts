import { marketList, markets, type MarketId } from "./markets.ts";

export const marketRequestHeader = "x-griip-current-market";
export const languageRequestHeader = "x-griip-current-language";
export const countryHintHeader = "x-griip-country-hint";
const storefrontRoute = /^\/(?:$|account(?:\/|$)|blog(?:\/|$)|pages(?:\/|$)|brands(?:\/|$)|compare(?:\/|$)|cart(?:\/|$)|checkout(?:\/|$)|collections(?:\/|$)|coupons(?:\/|$)|departments(?:\/|$)|favorites(?:\/|$)|gifts(?:\/|$)|help(?:\/|$)|lists(?:\/|$)|messages(?:\/|$)|orders(?:\/|$)|products(?:\/|$)|recent(?:\/|$)|registry(?:\/|$)|search(?:\/|$)|shop(?:\/|$)|shops(?:\/|$))/;

export function regionalMarket(path: string) {
  return marketList.find(market => market.pathPrefix && (path === market.pathPrefix || path.startsWith(market.pathPrefix + "/")));
}

export function withoutRegionalPrefix(path: string) {
  const prefix = regionalMarket(path)?.pathPrefix;
  return prefix ? path.slice(prefix.length) || "/" : path;
}

export function localizedStorePath(path: string, market: MarketId) {
  const bare = withoutRegionalPrefix(path);
  const prefix = markets[market].pathPrefix;
  return prefix && storefrontRoute.test(bare) ? `${prefix}${bare === "/" ? "" : bare}` : bare;
}

export function isRegionalStorePath(path: string) {
  return storefrontRoute.test(path);
}

export function productLandingPath(slug: string, market: MarketId, regional: boolean, variantId?: string) {
  const path = `/products/${encodeURIComponent(slug)}`;
  const query = new URLSearchParams({ market });
  if (variantId) query.set("variant", variantId);
  return `${regional ? localizedStorePath(path, market) : path}?${query}`;
}
