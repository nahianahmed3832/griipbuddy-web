import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { storefrontCookiePath } from "@/config/storefront-path";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { getDb } from "@/lib/db/client";
import { currentMarket } from "@/lib/market-server";
import {
  choiceSeconds, cookieId, grantMeasurement, measurementCookie, measurementEnabled,
  measurementInput, recordMeasurement, revokeMeasurement,
} from "@/lib/measurement/server";

const reply = (choice: "off" | "on" | "blocked" | "expired" | "unavailable", status = 200) =>
  NextResponse.json({ choice }, { status, headers: privateHeaders });

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
  if (request.headers.get("sec-fetch-site") === "cross-site") return reply("off", 403);
  const token = (await cookies()).get(measurementCookie)?.value;
  try {
    // GET never mutates choices. Honor GPC for this request and all write paths.
    if (request.headers.get("sec-gpc") === "1") return reply("blocked");
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
  const input = measurementInput.safeParse(await readJson(request, 2048));
  if (!input.success) return reply("off", 400);
  const token = (await cookies()).get(measurementCookie)?.value;
  try {
    if (request.headers.get("sec-gpc") === "1" || input.data.action === "withdraw") {
      return await doNotMeasure(token, request.headers.get("sec-gpc") === "1");
    }
    const id = cookieId(token);
    if (input.data.action === "allow") {
      if (id && await getDb().measurementJourney.count({ where: { id, expiresAt: { gt: new Date() } } })) return reply("on");
      if (!await consumeQuota("measurement.consent", clientKey(request.headers), 80, 60)) return reply("off", 429);
      if (id) await revokeMeasurement(token);
      const granted = await grantMeasurement();
      return setChoice(reply("on"), granted, choiceSeconds);
    }
    if (!id) return reply("off", 403);
    if (!await consumeQuota("measurement.event", id, 90, 60)) return reply("on", 429);
    const market = await currentMarket();
    return await recordMeasurement(id, market.id, input.data) ? reply("on") : reply("off", 422);
  } catch (error) {
    reportFailure("measurement.write", undefined, error);
    return reply("unavailable", 503);
  }
}
