import { marketIds, markets, type MarketId } from "./markets.ts";

export const marketRequestHeader = "x-griip-current-market";
export const globalAccountRequestHeader = "x-griip-global-account";
export const countryHintHeader = "x-griip-country-hint";
const storefrontRoute = /^\/(?:$|account(?:\/|$)|cart(?:\/|$)|checkout(?:\/|$)|collections(?:\/|$)|departments(?:\/|$)|favorites(?:\/|$)|gifts(?:\/|$)|help(?:\/|$)|lists(?:\/|$)|messages(?:\/|$)|orders(?:\/|$)|products(?:\/|$)|registry(?:\/|$)|search(?:\/|$)|shop(?:\/|$)|shops(?:\/|$))/;

export function regionalPathMarket(path: string) {
  return marketIds.find(id => {
    const { pathPrefix } = markets[id];
    return pathPrefix && (path === pathPrefix || path.startsWith(`${pathPrefix}/`));
  });
}

export function withoutRegionalPrefix(path: string) {
  const market = regionalPathMarket(path);
  return market ? path.slice(markets[market].pathPrefix.length) || "/" : path;
}

export function localizedStorePath(path: string, market: MarketId) {
  const bare = withoutRegionalPrefix(path);
  const { pathPrefix } = markets[market];
  return pathPrefix && storefrontRoute.test(bare) ? `${pathPrefix}${bare === "/" ? "" : bare}` : bare;
}

export function localizedStoreHref(href: string, market?: MarketId) {
  if (!market) return href;
  const suffix = href.search(/[?#]/);
  if (suffix < 0) return localizedStorePath(href, market);
  return localizedStorePath(href.slice(0, suffix), market) + href.slice(suffix);
}

export function marketStoreHref(href: string, market?: MarketId) {
  if (!market || !storefrontRoute.test(withoutRegionalPrefix(href.split(/[?#]/, 1)[0]))) return href;
  const url = new URL(localizedStoreHref(href, market), "https://storefront.invalid");
  if (!markets[market].pathPrefix) url.searchParams.set("market", market);
  else url.searchParams.delete("market");
  return url.pathname + url.search + url.hash;
}

export function marketStoreUrl(href: string, market: MarketId, configuredOrigin: string) {
  const base = new URL(configuredOrigin);
  const target = new URL(marketStoreHref(href, market), base);
  if (target.origin !== base.origin || !isRegionalStorePath(withoutRegionalPrefix(target.pathname))) {
    throw new Error("A market destination must be on the configured storefront.");
  }
  return target;
}

export function marketPreferenceTarget(current: URL, market: MarketId) {
  const target = new URL(current);
  target.pathname = localizedStorePath(target.pathname, market);
  target.searchParams.delete("market");
  if (withoutRegionalPrefix(target.pathname) === "/checkout") target.searchParams.set("destination", market);
  else if (!markets[market].pathPrefix) target.searchParams.set("market", market);
  return target;
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
