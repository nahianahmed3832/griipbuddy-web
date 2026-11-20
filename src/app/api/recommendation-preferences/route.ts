import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getRecommendationPreference, lockRecommendationJourney, lockRecommendationPreference, recommendationViewerScope,
} from "@/lib/catalog/recommendation-preferences";
import { deleteRecommendationExperimentHistory } from "@/lib/catalog/recommendation-experiment";
import { getDb } from "@/lib/db/client";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { measurementAccountKey } from "@/lib/measurement/server";

const input = z.strictObject({ action: z.enum(["allow", "disable", "reset"]) });
const reply = (choice: "on" | "off" | "blocked" | "unavailable", scope: string | null = null, status = 200) =>
  NextResponse.json({ choice, scope }, { status, headers: privateHeaders });

export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return reply("off", null, 403);
  try {
    const preference = await getRecommendationPreference(request);
    return reply(preference.blocked ? "blocked" : preference.enabled ? "on" : "off", recommendationViewerScope(preference));
  } catch (error) {
    reportFailure("recommendation-preferences.status", undefined, error);
    return reply("unavailable", null, 503);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return reply("off", null, 403);
  const parsed = input.safeParse(await readJson(request, 512));
  if (!parsed.success) return reply("off", null, 400);
  try {
    const { action } = parsed.data;
    const preference = await getRecommendationPreference(request, action === "allow");
    if (!preference.journeyId || preference.blocked && action === "allow") {
      return reply(preference.blocked ? "blocked" : "off", null, action === "allow" ? 403 : 200);
    }
    const { journeyId } = preference;
    if (action === "allow" && preference.enabled) return reply("on", recommendationViewerScope(preference));
    if (!await consumeQuota("recommendation-preferences.write", clientKey(request.headers), 60, 60)) return reply("off", null, 429);
    const shopperId = (await getShopper())?.id ?? null;
    const shopperKey = shopperId ? measurementAccountKey(shopperId) : null;
    const result = await getDb().$transaction(async tx => {
      if (!await lockRecommendationJourney(tx, journeyId)) return null;
      const existing = await lockRecommendationPreference(tx, journeyId);
      const owns = existing?.shopperKey === shopperKey;
      if (existing?.enabled && owns && action === "allow") return existing;
      // An anonymous reset can't re-enable a previously bound shopper's choice.
      const enabled = action === "allow" || action === "reset" && owns && existing?.enabled === true && !preference.blocked;
      const since = new Date(Math.max(Date.now(), existing ? +existing.since + 1 : 0));
      if (existing) await deleteRecommendationExperimentHistory(journeyId, tx);
      if (owns && shopperId && action !== "allow") {
        await tx.$executeRaw`
          INSERT INTO "RecommendationAccountReset" ("shopperId", since) VALUES (${shopperId}, ${since})
          ON CONFLICT ("shopperId") DO UPDATE SET since = GREATEST("RecommendationAccountReset".since, EXCLUDED.since)
        `;
      }
      const update = { enabled, since, shopperKey, associatedAt: shopperKey ? since : null };
      return tx.recommendationPreference.upsert({ where: { journeyId }, create: { journeyId, ...update }, update });
    });
    return reply(preference.blocked ? "blocked" : result?.enabled ? "on" : "off",
      result && recommendationViewerScope({ ...result, journeyId, shopperId, blocked: preference.blocked }) || null);
  } catch (error) {
    reportFailure("recommendation-preferences.write", undefined, error);
    return reply("unavailable", null, 503);
  }
}
