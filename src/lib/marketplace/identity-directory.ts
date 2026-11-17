import type { MarketId } from "../../config/markets.ts";
import { marketStoreHref } from "../../config/regional-path.ts";
import { storefrontBasePath, storefrontPath } from "../../config/storefront-path.ts";

const shoppersMarkets = ["bd", "us"] as const;
export type HandoffMarket = (typeof shoppersMarkets)[number];
export const globalAccountPath = "/global-account";
export const preferredStoreCookie = "griipbuddy-preferred-store";
const handoffPath = "/api/shopper-handoff";
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const orderId = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const allowedReturn = new RegExp(`^/(?:account(?:/(?:addresses|help|settings))?|orders(?:/${orderId}(?:/cases/${orderId})?)?)$`, "i");

export function isHandoffMarket(value: unknown): value is HandoffMarket {
  return value === "bd" || value === "us";
}

function configuredOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const permitted = url.protocol === "https:" ||
      (process.env.COMMERCE_MODE === "local" && url.protocol === "http:" && localHosts.has(url.hostname));
    if (permitted && (value === url.origin || value === `${url.origin}/`)) return url.origin;
  } catch { /* Invalid origins leave the handoff disabled. */ }
}

export function shopperIdentityDirectory() {
  const issuer = configuredOrigin(process.env.SHOPPER_IDENTITY_ORIGIN);
  const current = configuredOrigin(process.env.BETTER_AUTH_URL);
  const bd = configuredOrigin(process.env.SHOPPER_BD_ORIGIN);
  const us = configuredOrigin(process.env.SHOPPER_US_ORIGIN);
  if (!issuer || !current || !bd || !us || bd === us || ![issuer, bd, us].includes(current)) return null;
  return { issuer, current, stores: { bd, us }, localMarket: shoppersMarkets.find(market => (market === "bd" ? bd : us) === current) };
}

/** Carry only account routes. Credentials, recovery tokens, hashes and arbitrary URLs stay on their original origin. */
export function accountReturnPath(value: string | null | undefined) {
  if (!value || value.length > 400) return "/account";
  const path = value.split(/[?#]/, 1)[0];
  const local = storefrontBasePath && path.startsWith(`${storefrontBasePath}/`) ? path.slice(storefrontBasePath.length) : path;
  const bare = local.replace(/^\/bd(?=\/)/, "");
  return allowedReturn.test(bare) ? bare : "/account";
}

export function registeredStorefrontHref(path: string, market: MarketId) {
  const directory = shopperIdentityDirectory();
  const href = marketStoreHref(path, market);
  if (!directory || !isHandoffMarket(market) || directory.stores[market] === directory.current) return href;
  return new URL(storefrontPath(href), directory.stores[market]).href;
}

export function identityHomeHref() {
  const directory = shopperIdentityDirectory();
  return directory && directory.issuer !== directory.current
    ? new URL(storefrontPath(globalAccountPath), directory.issuer).href : storefrontPath(globalAccountPath);
}

export function chooseStorefrontHref(market: MarketId, returnPath = "/account") {
  return `${identityHomeHref()}/open?${new URLSearchParams({ market, return: accountReturnPath(returnPath) })}`;
}

export function storefrontHandoffUrl(step: "start" | "authorize" | "finish" | "readiness", origin: string, query: Record<string, string> = {}) {
  const url = new URL(storefrontPath(`${handoffPath}/${step}`), origin);
  url.search = new URLSearchParams(query).toString();
  return url;
}

export function identityEntryUrl(issuer: string, query: Record<string, string> = {}) {
  const url = new URL(storefrontPath(globalAccountPath), issuer);
  url.search = new URLSearchParams(query).toString();
  return url;
}
