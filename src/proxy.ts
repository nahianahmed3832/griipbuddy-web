import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode, productionMode, storefrontIndexingEnabled } from "@/lib/release-config";
import { storefrontBasePath, storefrontCookiePath, storefrontPath } from "@/config/storefront-path";
import { languageCookie, marketCookie, marketList, type MarketId } from "@/config/markets";
import {
  countryHintHeader, isRegionalStorePath, languageRequestHeader, localizedStorePath, marketRequestHeader, productLandingPath, regionalMarket, withoutRegionalPrefix,
} from "@/config/regional-path";
import { secureCookies } from "@/lib/db/http";
import { isMarketSelectable, marketConfiguration, marketLanguage, resolveMarketLocale, selectedMarketId } from "@/lib/market-config";

const noIndex = { "X-Robots-Tag": "noindex, nofollow" };
const restrictedPath = /^\/(?:cart|checkout|orders|staff|api|search)(?:\/|$)/;
const sellerPath = /^\/(?:sell|seller|shops|api\/marketplace\/(?:seller|listing-photo))(?:\/|$)/;
const staffPath = /^\/staff(?:\/|$)/;
const adminPath = /^\/admin(?:\/|$)/;
const isPageRead = (request: NextRequest) => request.method === "GET" || request.method === "HEAD";

function explicitMarket(request: NextRequest) {
  if (!isPageRead(request) || !isRegionalStorePath(withoutRegionalPrefix(request.nextUrl.pathname))) return;
  const values = request.nextUrl.searchParams.getAll("market");
  if (values.length === 1 && isMarketSelectable(values[0])) return values[0];
}

function explicitLanguage(request: NextRequest, marketId: MarketId) {
  if (!isPageRead(request) || !isRegionalStorePath(withoutRegionalPrefix(request.nextUrl.pathname))) return;
  const values = request.nextUrl.searchParams.getAll("lang");
  if (values.length === 1) return marketLanguage(marketConfiguration(marketId), values[0]);
}

function setSelectionCookie(request: NextRequest, response: NextResponse, name: string, value: string) {
  if (request.cookies.get(name)?.value === value || request.headers.has("next-router-prefetch") ||
      request.headers.get("purpose")?.includes("prefetch") || request.headers.get("sec-purpose")?.includes("prefetch")) return;
  response.cookies.set(name, value, {
    path: storefrontCookiePath, httpOnly: true, secure: secureCookies(), sameSite: "lax", maxAge: 365 * 86400,
  });
}

function continueRequest(request: NextRequest, headers?: Record<string, string>, downstream?: Headers) {
  const market = explicitMarket(request);
  const language = request.nextUrl.searchParams.has("lang")
    ? explicitLanguage(request, market ?? selectedMarketId(request.cookies.get(marketCookie)?.value)) : undefined;
  if (isRegionalStorePath(request.nextUrl.pathname)) headers = { ...headers, "Cache-Control": "private, no-store" };
  if (!market && !language && !downstream && !request.headers.has(marketRequestHeader) && !request.headers.has(languageRequestHeader)) {
    return NextResponse.next({ headers });
  }
  downstream ??= new Headers(request.headers);
  downstream.delete(marketRequestHeader);
  downstream.delete(languageRequestHeader);
  if (market) downstream.set(marketRequestHeader, market);
  if (language) downstream.set(languageRequestHeader, language);
  const response = NextResponse.next({ request: { headers: downstream }, headers });
  if (market) setSelectionCookie(request, response, marketCookie, market);
  if (language) setSelectionCookie(request, response, languageCookie, language);
  return response;
}

function hybridRouting(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const target = new URL(process.env.BETTER_AUTH_URL!);
  target.pathname = request.nextUrl.pathname;
  target.search = request.nextUrl.search;
  const incoming = new Headers(request.headers);
  incoming.delete(marketRequestHeader);
  incoming.delete(languageRequestHeader);
  const headers = { ...noIndex, "Cache-Control": "private, no-store", "Referrer-Policy": "strict-origin" };
  if (adminPath.test(path)) return NextResponse.next({ request: { headers: incoming }, headers });
  if (staffPath.test(path) && isPageRead(request)) {
    target.pathname = `/admin${path.slice("/staff".length)}`;
    return NextResponse.redirect(target, { headers });
  }

  const bare = withoutRegionalPrefix(path);
  if (!isRegionalStorePath(bare) || !isPageRead(request)) {
    return NextResponse.next({ request: { headers: incoming }, headers });
  }
  const override = explicitMarket(request);
  const prior = request.cookies.get(marketCookie)?.value;
  const hintedMarket = marketList.find(item => item.countryCode === request.headers.get(countryHintHeader))?.id;
  const market = selectedMarketId(override ?? regionalMarket(path)?.id ?? (isMarketSelectable(prior) ? prior : hintedMarket), "us");
  const language = explicitLanguage(request, market);
  const marketPath = localizedStorePath(bare, market);
  if (path !== marketPath) {
    target.pathname = storefrontPath(marketPath);
    const response = NextResponse.redirect(target, { headers });
    setSelectionCookie(request, response, marketCookie, market);
    if (language) setSelectionCookie(request, response, languageCookie, language);
    return response;
  }

  incoming.set(marketRequestHeader, market);
  if (language) incoming.set(languageRequestHeader, language);
  const response = NextResponse.next({ request: { headers: incoming }, headers });
  setSelectionCookie(request, response, marketCookie, market);
  if (language) setSelectionCookie(request, response, languageCookie, language);
  return response;
}

function accessResponse(request: NextRequest) {
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

export async function proxy(request: NextRequest) {
  const response = accessResponse(request);
  if (!(response instanceof NextResponse) || response.headers.get("x-middleware-next") !== "1") return response;
  const path = request.nextUrl.pathname;
  if (path.startsWith("/staff/catalog") || path.startsWith("/api/staff/") || path.includes("%")) {
    const { retiredCatalogBrowserResponse } = await import("@/lib/catalog/main-admin-browser");
    const retired = await retiredCatalogBrowserResponse(request, request.nextUrl,
      request.cookies.get(marketCookie)?.value);
    if (retired) return retired;
  }
  if (!isPageRead(request)) return response;
  const bare = withoutRegionalPrefix(path);
  const product = /^\/products\/([a-z0-9-]+)$/.exec(bare)?.[1];
  const category = /^\/departments\/([^/]+)$/.exec(bare)?.[1];
  if (!product && !category) return response;
  const hybrid = hybridDemoMode();
  const market = selectedMarketId(explicitMarket(request) ?? (hybrid ? regionalMarket(path)?.id : undefined) ??
    request.cookies.get(marketCookie)?.value, hybrid ? "us" : undefined);
  let destination: URL;
  if (product) {
    const { resolveMigratedProductLanding } = await import("@/lib/catalog-migration/compatibility");
    const variant = request.nextUrl.searchParams.getAll("variant");
    const target = await resolveMigratedProductLanding(product, market, variant.length === 1 ? variant[0] : null);
    if (!target) return response;
    destination = new URL(storefrontPath(productLandingPath(target.slug, market, hybrid, target.variantId)), request.url);
    if (variant.length && !target.variantId) {
      // Keep the request explicit when the exact variant is no longer market-visible.
      const bounded = variant.length <= 2 && variant.every(value => value.length <= 80);
      for (const value of bounded ? variant : [""]) destination.searchParams.append("variant", value);
    }
    const options = request.nextUrl.searchParams.getAll("option");
    for (const value of options.length <= 24 && options.every(option => option.length <= 200) ? options : ["invalid"]) {
      destination.searchParams.append("option", value);
    }
    const language = explicitLanguage(request, market);
    if (language) destination.searchParams.set("lang", language);
    const categoryId = request.nextUrl.searchParams.get("category");
    if (categoryId && /^[a-z0-9][a-z0-9-]{0,79}$/.test(categoryId)) destination.searchParams.set("category", categoryId);
  } else {
    let slug: string;
    try { slug = decodeURIComponent(category!); } catch { return response; }
    const locale = resolveMarketLocale(marketConfiguration(market), explicitLanguage(request, market) ??
      request.cookies.get(languageCookie)?.value, request.headers.get("accept-language"));
    const { resolveDepartmentRedirect } = await import("@/lib/catalog/category-redirect");
    const target = await resolveDepartmentRedirect(slug, market, locale);
    if (!target) return response;
    const categoryPath = `/departments/${encodeURIComponent(target)}`;
    destination = new URL(storefrontPath(hybrid ? localizedStorePath(categoryPath, market) : categoryPath), request.url);
    destination.search = request.nextUrl.search;
  }
  const headers = new Headers();
  for (const name of ["Cache-Control", "X-Robots-Tag", "Referrer-Policy"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const redirect = NextResponse.redirect(destination, { status: 308, headers });
  for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = { matcher: "/:path*" };
