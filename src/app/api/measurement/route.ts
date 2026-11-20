import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { storefrontCookiePath } from "@/config/storefront-path";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { getDb } from "@/lib/db/client";
import { currentMarket } from "@/lib/market-server";
import {
  choiceSeconds, cookieId, grantMeasurement, hasStaffMeasurementSession, measurementCookie, measurementEnabled,
  measurementInput, recordMeasurement, revokeMeasurement,
} from "@/lib/measurement/server";
import { getShopper } from "@/lib/marketplace/auth";
import { getRecommendationPreference } from "@/lib/catalog/recommendation-preferences";

const recommendationSignals = new Set([
  "PRODUCT_VIEW", "SEARCH", "SEARCH_FILTER", "WISHLIST_ADD", "WISHLIST_REMOVE", "CART_ADD", "CART_UPDATE", "CART_REMOVE",
]);

const reply = (choice: "off" | "on" | "blocked" | "expired" | "unavailable", status = 200) =>
  NextResponse.json({ choice }, { status, headers: privateHeaders });

function knownAutomatedAgent(request: Request) {
  const agent = request.headers.get("user-agent") ?? "";
  return /(?:\bbot\b|[a-z]bot\b|\bcrawler\b|\bspider\b|facebookexternalhit|Bytespider|Slackbot)/i.test(agent);
}

function setChoice(response: NextResponse, value: string, maxAge: number) {
  response.cookies.set(measurementCookie, value, {
    path: storefrontCookiePath, httpOnly: true, secure: secureCookies(), sameSite: "lax", maxAge,
  });
  return response;
}

async function doNotMeasure(token: string | undefined, blocked: boolean) {
  // Report a failed deletion to the caller, which can retry. Reading the GPC
  // signal always takes priority over the stored choice on any write path.
  await revokeMeasurement(token);
  return setChoice(reply(blocked ? "blocked" : "off"), "", 0);
}

export async function GET(request: Request) {
  if (!measurementEnabled()) return reply("unavailable");
  if (knownAutomatedAgent(request)) return reply("blocked");
  if (request.headers.get("sec-fetch-site") === "cross-site") return reply("off", 403);
  const token = (await cookies()).get(measurementCookie)?.value;
  try {
    // GET never mutates choices. Honor GPC for this request and all write paths.
    if (request.headers.get("sec-gpc") === "1" || hasStaffMeasurementSession(request.headers)) return reply("blocked");
    const market = await currentMarket();
    if (market.analytics.structured === "disabled") return reply("unavailable");
    const id = cookieId(token);
    if (!id) return reply("off");
    const row = await getDb().measurementJourney.findUnique({ where: { id }, select: { expiresAt: true } });
    return reply(!row ? "off" : +row.expiresAt > Date.now() ? "on" : "expired");
  } catch (error) {
    reportFailure("measurement.status", undefined, error);
    return reply("unavailable", 503);
  }
}

export async function POST(request: Request) {
  if (!measurementEnabled()) return reply("unavailable", 404);
  if (!sameOrigin(request)) return reply("off", 403);
  if (knownAutomatedAgent(request)) return reply("blocked", 403);
  const input = measurementInput.safeParse(await readJson(request, 4096));
  if (!input.success) return reply("off", 400);
  const token = (await cookies()).get(measurementCookie)?.value;
  try {
    const blocked = request.headers.get("sec-gpc") === "1" || hasStaffMeasurementSession(request.headers);
    if (blocked || input.data.action === "withdraw") {
      return await doNotMeasure(token, blocked);
    }
    const market = await currentMarket();
    if (market.analytics.structured === "disabled") return reply("unavailable", 404);
    const id = cookieId(token);
    if (input.data.action === "allow") {
      if (id && await getDb().measurementJourney.count({ where: { id, expiresAt: { gt: new Date() } } })) return reply("on");
      if (!await consumeQuota("measurement.consent", clientKey(request.headers), 80, 60)) return reply("off", 429);
      if (id) await revokeMeasurement(token);
      const granted = await grantMeasurement();
      return setChoice(reply("on"), granted, choiceSeconds);
    }
    if (!id) return reply("off", 403);
    if (!await consumeQuota("measurement.event", id, 240, 60)) return reply("on", 429);
    const eventMarket = "marketId" in input.data ? input.data.marketId : market.id;
    if (eventMarket !== market.id) return reply("on", 422);
    const experiment = input.data.action === "EXPERIMENT_EXPOSURE" ||
      "experimentAssignment" in input.data && !!input.data.experimentAssignment;
    const preference = (experiment || recommendationSignals.has(input.data.action))
      ? await getRecommendationPreference(request).catch(error => {
        reportFailure("measurement.recommendation-preference", undefined, error);
        return null;
      }) : null;
    const allowed = preference?.enabled === true && preference.journeyId === id;
    const shopperId = input.data.action === "ACCOUNT_ASSOCIATED" ? (await getShopper())?.id
      : allowed ? preference.shopperId ?? undefined : undefined;
    if (await recordMeasurement(id, eventMarket, input.data, shopperId, experiment && allowed ? preference.since ?? undefined : undefined)) {
      return reply("on");
    }
    const active = await getDb().measurementJourney.count({ where: { id, expiresAt: { gt: new Date() } } });
    return active ? reply("on", 422) : reply("expired", 403);
  } catch (error) {
    reportFailure("measurement.write", undefined, error);
    return reply("unavailable", 503);
  }
}
