import { languageCookie, marketCookie } from "@/config/markets";
import { preferenceCookie, shoppingPreferenceDestination } from "@/lib/catalog/preference-destination";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { marketplaceMode } from "@/lib/release-config";
import { isMarketSelectable } from "@/lib/market-config";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const body = await readJson(request, 8192);
  if (!body || typeof body !== "object") return new Response(null, { status: 422 });
  if ("marketId" in body) {
    const preferences = await shoppingPreferenceDestination(body);
    if (!preferences) return new Response(null, { status: 422 });
    const response = NextResponse.json({ ok: true, href: preferences.href }, { headers: privateHeaders });
    response.cookies.set(marketCookie, preferences.marketId, preferenceCookie());
    response.cookies.set(languageCookie, preferences.locale, preferenceCookie());
    return response;
  }
  if (!("region" in body) || !isMarketSelectable(body.region)) return new Response(null, { status: 422 });
  const response = NextResponse.json({ ok: true }, { headers: privateHeaders });
  response.cookies.set(marketCookie, body.region, preferenceCookie());
  return response;
}
