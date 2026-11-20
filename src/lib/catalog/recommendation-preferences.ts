import { cookies, headers } from "next/headers";
import { currentMarket } from "../market-server.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { getShopper } from "../marketplace/auth.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { cookieId, hasStaffMeasurementSession, measurementAccountKey, measurementCookie, measurementEnabled } from "../measurement/server.ts";

export type RecommendationPreference = {
  enabled: boolean;
  since: Date | null;
  journeyId: string | null;
  shopperId: string | null;
  shopperKey: string | null;
  associatedAt: Date | null;
  blocked: boolean;
};

export async function lockRecommendationJourney(db: DbReader, journeyId: string) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "MeasurementJourney"
    WHERE id = ${journeyId} AND "expiresAt" > CURRENT_TIMESTAMP
    FOR SHARE
  `;
  return rows.length > 0;
}

export async function lockRecommendationPreference(db: DbReader, journeyId: string) {
  const rows = await db.$queryRaw<{ enabled: boolean; since: Date; shopperKey: string | null; associatedAt: Date | null }[]>`
    SELECT enabled, since, "shopperKey", "associatedAt"
    FROM "RecommendationPreference" WHERE "journeyId" = ${journeyId}
    FOR UPDATE
  `;
  return rows[0];
}

export async function getRecommendationPreference(request?: Request, claim = true): Promise<RecommendationPreference> {
  const [requestHeaders, cookieStore, market] = await Promise.all([request?.headers ?? headers(), cookies(), currentMarket()]);
  const blocked = requestHeaders.get("sec-gpc") === "1" || hasStaffMeasurementSession(requestHeaders);
  const available = measurementEnabled() && market.analytics.structured !== "disabled";
  const journeyId = available ? cookieId(cookieStore.get(measurementCookie)?.value) : null;
  const off = { enabled: false, since: null, journeyId, shopperId: null, shopperKey: null, associatedAt: null, blocked };
  if (!journeyId || blocked) return off;
  const db = getDb();
  const row = await db.recommendationPreference.findFirst({
    where: { journeyId, enabled: true, journey: { expiresAt: { gt: new Date() } } },
    select: { since: true, shopperKey: true, associatedAt: true },
  });
  if (!row) return off;
  const shopperId = (await getShopper())?.id ?? null;
  const shopperKey = shopperId ? measurementAccountKey(shopperId) : null;
  if (row.shopperKey && row.shopperKey !== shopperKey) return off;
  if (!row.shopperKey && shopperKey) {
    // The first authenticated shopper can carry this browser's anonymous intent.
    // Signing out or using a different account can't read those preferences.
    const claimed = await db.$transaction(async tx => {
      if (!await lockRecommendationJourney(tx, journeyId)) return null;
      const fresh = await lockRecommendationPreference(tx, journeyId);
      if (!fresh?.enabled || +fresh.since !== +row.since || (fresh.shopperKey && fresh.shopperKey !== shopperKey)) return null;
      if (fresh.shopperKey) return fresh;
      if (!claim) return null;
      return tx.recommendationPreference.update({
        where: { journeyId },
        data: { shopperKey, associatedAt: new Date() },
        select: { since: true, shopperKey: true, associatedAt: true },
      });
    });
    if (!claimed) return off;
    return { enabled: true, since: claimed.since, journeyId, shopperId, shopperKey, associatedAt: claimed.associatedAt, blocked };
  }
  return { enabled: true, since: row.since, journeyId, shopperId, shopperKey, associatedAt: row.associatedAt, blocked };
}

export function recommendationViewerScope(preference: RecommendationPreference) {
  if (!preference.enabled || !preference.since || !preference.journeyId) return null;
  return stableMeasurementId("recommendation-viewer", preference.journeyId, preference.shopperKey ?? "", preference.since.toISOString()).slice(0, 32);
}
