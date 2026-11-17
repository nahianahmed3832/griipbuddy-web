import { isStorefrontMarketId, marketCookie } from "@/config/markets";
import { storefrontCookiePath } from "@/config/storefront-path";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { preferredStoreCookie } from "@/lib/marketplace/identity-directory";
import { fixtureMarketEnabled, marketplaceMode } from "@/lib/release-config";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const body = await readJson(request, 1024);
  if (!body || typeof body !== "object" || !("region" in body) || !isStorefrontMarketId(body.region, fixtureMarketEnabled())) {
    return new Response(null, { status: 422 });
  }
  const response = NextResponse.json({ ok: true }, { headers: privateHeaders });
  const options = { path: storefrontCookiePath, httpOnly: true, secure: secureCookies(), sameSite: "lax" as const, maxAge: 365 * 86400 };
  response.cookies.set(marketCookie, body.region, options);
  response.cookies.set(preferredStoreCookie, body.region, options);
  return response;
}
