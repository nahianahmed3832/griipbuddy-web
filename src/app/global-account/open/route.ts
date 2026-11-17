import { NextResponse, type NextRequest } from "next/server";
import { isStorefrontMarketId } from "@/config/markets";
import { storefrontCookiePath, storefrontPath } from "@/config/storefront-path";
import { privateHeaders, secureCookies } from "@/lib/db/http";
import { getShopper } from "@/lib/marketplace/auth";
import { accountReturnPath, isHandoffMarket, preferredStoreCookie, registeredStorefrontHref, shopperIdentityDirectory, storefrontHandoffUrl } from "@/lib/marketplace/identity-directory";
import { fixtureMarketEnabled, marketplaceMode } from "@/lib/release-config";

export async function GET(request: NextRequest) {
  const market = request.nextUrl.searchParams.get("market");
  if (!marketplaceMode() || !isStorefrontMarketId(market, fixtureMarketEnabled())) {
    return new Response(null, { status: 404, headers: privateHeaders });
  }
  const path = accountReturnPath(request.nextUrl.searchParams.get("return"));
  const href = registeredStorefrontHref(path, market);
  let destination = new URL(href.startsWith("/") ? storefrontPath(href) : href, process.env.BETTER_AUTH_URL);
  const directory = shopperIdentityDirectory();
  if (directory && directory.issuer === directory.current && destination.origin !== directory.current && isHandoffMarket(market)
      && await getShopper().catch(() => null)) {
    destination = storefrontHandoffUrl("start", destination.origin, { market, return: path });
  }
  const response = NextResponse.redirect(destination, { status: 303, headers: privateHeaders });
  response.cookies.set(preferredStoreCookie, market, { path: storefrontCookiePath, sameSite: "lax", httpOnly: true,
    secure: secureCookies(), maxAge: 365 * 86400 });
  return response;
}
