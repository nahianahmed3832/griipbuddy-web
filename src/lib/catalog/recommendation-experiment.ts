import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import type { MarketId } from "@/config/markets";
import { sameOrigin } from "@/lib/db/http";
import { marketConfiguration } from "@/lib/market-config";
import { cookieId, hasStaffMeasurementSession, measurementCookie, measurementSessionHeader } from "@/lib/measurement/server";
import { getRecommendationPreference } from "./recommendation-preferences";
import { enrollRecommendationExperiment, recommendationExperimentEnabled } from "./recommendation-experiment-data";

export { deleteRecommendationExperimentHistory, recordRecommendationExperimentLatency } from "./recommendation-experiment-data";

type FeaturedContext = { marketId: MarketId; locale: string; version: string; productIds: readonly string[] };

function featuredSignature(context: FeaturedContext, expires: number) {
  const secret = process.env.CHECKOUT_SECRET;
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(JSON.stringify([
    "recommendation-baseline-v1", context.marketId, context.locale, context.version, context.productIds, expires,
  ])).digest("hex");
}

export function featuredPlacementProof(context: FeaturedContext) {
  if (!recommendationExperimentEnabled() || !context.productIds.length) return undefined;
  const expires = Math.floor(Date.now() / 1000) + 1800;
  const signature = featuredSignature(context, expires);
  return signature ? `${expires}.${signature}` : undefined;
}

export function verifyFeaturedPlacementProof(context: FeaturedContext, proof?: string) {
  const parts = proof?.match(/^(\d{10})\.([a-f0-9]{64})$/);
  if (!parts || !context.productIds.length) return false;
  const expires = Number(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + 1800) return false;
  const expected = featuredSignature(context, expires);
  return Boolean(expected && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts[2], "hex")));
}

export async function recommendationExperimentAssignment(marketId: MarketId, request: Request) {
  if (!recommendationExperimentEnabled() || !sameOrigin(request) || request.headers.get("sec-gpc") === "1" ||
      hasStaffMeasurementSession(request.headers) || marketConfiguration(marketId).analytics.structured === "disabled" ||
      !z.uuidv4().safeParse(request.headers.get(measurementSessionHeader)).success) return null;
  const journeyId = cookieId((await cookies()).get(measurementCookie)?.value);
  if (!journeyId) return null;
  const preference = await getRecommendationPreference(request);
  if (!preference.enabled || !preference.since || preference.journeyId !== journeyId) return null;
  return enrollRecommendationExperiment(marketId, journeyId, preference.since, preference.shopperKey);
}
