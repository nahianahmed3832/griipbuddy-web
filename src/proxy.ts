import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { firstPartyStoreMode, fixtureMarketEnabled, hybridDemoMode, marketplaceMode, productionMode, storefrontIndexingEnabled } from "@/lib/release-config";
import { storefrontBasePath, storefrontCookiePath, storefrontPath } from "@/config/storefront-path";
import { isStorefrontMarketId, marketCookie, markets, type MarketId } from "@/config/markets";
import { countryHintHeader, globalAccountRequestHeader, isRegionalStorePath, localizedStorePath, marketRequestHeader, marketStoreUrl, regionalPathMarket, withoutRegionalPrefix } from "@/config/regional-path";
import { secureCookies } from "@/lib/db/http";
import { catalogMediaPath } from "@/lib/catalog/media-size";
import { globalAccountPath, isHandoffMarket, shopperIdentityDirectory } from "@/lib/marketplace/identity-directory";

const noIndex = { "X-Robots-Tag": "noindex, nofollow" };
const restrictedPath = /^\/(?:cart|checkout|orders|staff|api|search)(?:\/|$)/;
const sellerPath = /^\/(?:sell|seller|shops|api\/marketplace\/(?:seller|listing-photo))(?:\/|$)/;
const staffPath = /^\/staff(?:\/|$)/;
const adminPath = /^\/admin(?:\/|$)/;
const productPath = /^\/products\/[^/]+\/?$/;
const identityPrivateRoute = /^\/(?:global-account|api\/shopper-handoff)(?:\/|$)/;

function requestHeaders(request: NextRequest, downstream = new Headers(request.headers)) {
  downstream.delete(marketRequestHeader);
  downstream.delete(globalAccountRequestHeader);
  if (request.nextUrl.pathname === globalAccountPath) downstream.set(globalAccountRequestHeader, "1");
  return downstream;
}

function productMarket(request: NextRequest) {
  const market = request.nextUrl.searchParams.get("market");
  if (["GET", "HEAD"].includes(request.method) && isStorefrontMarketId(market, fixtureMarketEnabled()) &&
      productPath.test(withoutRegionalPrefix(request.nextUrl.pathname))) return market;
}

function setMarketCookie(response: NextResponse, market: MarketId) {
  response.cookies.set(marketCookie, market, {
    path: storefrontCookiePath, httpOnly: true, secure: secureCookies(), sameSite: "lax", maxAge: 365 * 86400,
  });
}

function mayPersistHybridMarket(headers: Headers) {
  const fetchMode = headers.get("sec-fetch-mode");
  if ((fetchMode && fetchMode !== "navigate") || headers.get("sec-fetch-dest") === "empty") return false;
  // Next can hide Flight headers from Proxy. Real browser document navigations
  // still carry Fetch Metadata. The explicit region action also persists changes.
  if (headers.has("rsc") || headers.has("next-router-prefetch") || headers.has("next-router-segment-prefetch")) return false;
  return !["purpose", "sec-purpose"].some(name => /\b(?:prefetch|prerender)\b/i.test(headers.get(name) ?? ""));
}

function continueRequest(request: NextRequest, headers?: Record<string, string>, downstream?: Headers, persistMarket = true) {
  const market = productMarket(request);
  downstream = requestHeaders(request, downstream);
  if (identityPrivateRoute.test(request.nextUrl.pathname)) {
    headers = { ...headers, ...noIndex, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
  }
  if (market) downstream.set(marketRequestHeader, market);
  const response = NextResponse.next({ request: { headers: downstream }, headers });
  if (persistMarket && market && request.cookies.get(marketCookie)?.value !== market) setMarketCookie(response, market);
  return response;
}

function registeredMarketRedirect(request: NextRequest) {
  const directory = shopperIdentityDirectory();
  const path = request.nextUrl.pathname;
  const bare = withoutRegionalPrefix(path);
  if (!directory?.localMarket || !["GET", "HEAD"].includes(request.method) || !isRegionalStorePath(bare)) return;
  const destination = bare === "/checkout" ? request.nextUrl.searchParams.get("destination") : null;
  const desired = isHandoffMarket(destination) ? destination : regionalPathMarket(path) ?? request.nextUrl.searchParams.get("market");
  if (!isHandoffMarket(desired) || desired === directory.localMarket) return;
  const target = marketStoreUrl(path + request.nextUrl.search, desired, directory.stores[desired]);
  target.pathname = storefrontPath(target.pathname);
  return NextResponse.redirect(target, { headers: { ...noIndex, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
}

function hybridRouting(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const target = new URL(process.env.BETTER_AUTH_URL!);
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;
  const incoming = requestHeaders(request);
  const bare = withoutRegionalPrefix(path);
  if (["GET", "HEAD"].includes(request.method) && catalogMediaPath.test(path)) {
    // The media route applies the cache policy after checking publication and access.
    return NextResponse.next({ request: { headers: incoming }, headers: { ...noIndex, "Referrer-Policy": "strict-origin" } });
  }
  const privateLink = identityPrivateRoute.test(bare) ||
    /^\/(?:orders(?:\/|$)|api\/checkout\/order-recovery$|account(?:\/|$)|api\/shopper-auth\/|api\/marketplace\/(?:cases|account)$|(?:admin|staff)\/test-email$)/.test(bare);
  const headers = { ...noIndex, "Cache-Control": "private, no-store", "Referrer-Policy": privateLink ? "no-referrer" : "strict-origin" };
  if (adminPath.test(path)) return NextResponse.next({ request: { headers: incoming }, headers });
  if (staffPath.test(path) && ["GET", "HEAD"].includes(request.method)) {
    target.pathname = `/admin${path.slice("/staff".length)}`;
    return NextResponse.redirect(target, { headers });
  }

  if (!isRegionalStorePath(bare) || !["GET", "HEAD"].includes(request.method)) {
    return NextResponse.next({ request: { headers: incoming }, headers });
  }
  const selected = request.cookies.get(marketCookie)?.value;
  const override = target.searchParams.get("market");
  const destination = bare === "/checkout" ? target.searchParams.get("destination") : null;
  const fixtureEnabled = fixtureMarketEnabled();
  const selectedByPath = regionalPathMarket(path);
  if (!fixtureEnabled && ((!selectedByPath && override === "ca") || destination === "ca")) return new Response(null, { status: 404, headers });
  const requestedMarket = isStorefrontMarketId(destination, fixtureEnabled) ? destination
    : selectedByPath ?? (isStorefrontMarketId(override, fixtureEnabled) ? override : undefined);
  const persistMarket = mayPersistHybridMarket(request.headers);
  const landingMarket = !selectedByPath || selectedByPath === override ? productMarket(request) : undefined;
  if (landingMarket) {
    const landingPath = localizedStorePath(bare, landingMarket);
    if (path !== landingPath) {
      target.pathname = storefrontPath(landingPath);
      return NextResponse.redirect(target, { headers });
    }
    return continueRequest(request, headers, incoming, persistMarket);
  }
  if (requestedMarket) {
    const localizedPath = localizedStorePath(bare, requestedMarket);
    // Markets without a distinct path keep their selector through soft navigation.
    const keepMarket = !markets[requestedMarket].pathPrefix && override === requestedMarket;
    if (path !== localizedPath || (override !== null && !keepMarket)) {
      target.pathname = localizedPath;
      if (!keepMarket) target.searchParams.delete("market");
      const response = NextResponse.redirect(target, { headers });
      if (persistMarket) setMarketCookie(response, requestedMarket);
      return response;
    }
  }
  const market = shopperIdentityDirectory()?.localMarket ?? requestedMarket ?? (isStorefrontMarketId(selected, fixtureEnabled) ? selected
    : request.headers.get(countryHintHeader) === "BD" ? "bd" : "us");
  if (markets[market].pathPrefix && bare === path) {
    target.pathname = localizedStorePath(path, market);
    return NextResponse.redirect(target, { headers });
  }

  incoming.set(marketRequestHeader, market);
  request.cookies.set(marketCookie, market);
  incoming.set("cookie", request.headers.get("cookie") ?? "");
  const response = NextResponse.next({ request: { headers: incoming }, headers });
  if (persistMarket && selected !== market) setMarketCookie(response, market);
  return response;
}

export function proxy(request: NextRequest) {
  const registered = registeredMarketRedirect(request);
  if (registered) return registered;
  if (hybridDemoMode()) return hybridRouting(request);
  if (firstPartyStoreMode() && sellerPath.test(request.nextUrl.pathname)) {
    if (request.nextUrl.pathname === "/shops/griipbuddy") {
      return NextResponse.redirect(new URL(storefrontPath("/shop"), request.url), { headers: noIndex });
    }
    return new Response(null, { status: 404, headers: noIndex });
  }
  if (productionMode()) {
    const headers = !storefrontIndexingEnabled() || restrictedPath.test(request.nextUrl.pathname) ? noIndex : undefined;
    return continueRequest(request, headers);
  }
  if (process.env.COMMERCE_MODE !== "staging") return continueRequest(request, noIndex);
  if (marketplaceMode() && storefrontBasePath === "/marketplace" && process.env.BETTER_AUTH_URL === "https://dev.griipbuddy.com") {
    return continueRequest(request, { ...noIndex, "Cache-Control": "private, no-store" });
  }
  const { STAGING_USER: username, STAGING_PASSWORD: password, BETTER_AUTH_URL } = process.env;
  const headers = { ...noIndex, "Cache-Control": "private, no-store" };
  if (!username || username.includes(":") || !password || password.length < 24 ||
      !BETTER_AUTH_URL?.startsWith("https://")) {
    return new Response("Private storefront access is not configured.", { status: 503, headers });
  }
  const expected = Buffer.from(`${username}:${password}`).toString("base64");
  const supplied = request.headers.get("authorization")?.match(/^Basic ([A-Za-z0-9+/=]+)$/i)?.[1] ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (timingSafeEqual(digest(supplied), digest(expected))) {
    const downstream = new Headers(request.headers);
    downstream.delete("authorization");
    return continueRequest(request, headers, downstream);
  }
  return new Response("Sign in to the private GriipBuddy preview.", {
    status: 401, headers: { ...headers, "WWW-Authenticate": 'Basic realm="GriipBuddy Staging", charset="UTF-8"' },
  });
}

export const config = { matcher: "/:path*" };
