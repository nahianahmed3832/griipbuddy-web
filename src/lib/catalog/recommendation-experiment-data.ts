import type { MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { developmentAcceptanceDatabase, localDatabase, stagingDatabase } from "../db/local.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { hybridDemoMode } from "../release-config.ts";
import { recommendationExperimentPlan as plan, recommendationExperimentVariant, type RecommendationExperiment } from "./recommendation-experiment-plan.ts";

export function recommendationExperimentEnabled() {
  return process.env.GRIIP_RECOMMENDATION_EXPERIMENT === "1" && process.env.ACQUISITION_MEASUREMENT === "1" &&
    (localDatabase() === "griipbuddy_test" || developmentAcceptanceDatabase() ||
      (process.env.GRIIP_MARKET_REVIEW_FIXTURES === "1" && !hybridDemoMode() && stagingDatabase()));
}

export async function lockExperimentPreference(db: DbReader, journeyId: string, since: Date, shopperKey: string | null) {
  // Match the preference mutation lock order so measurement deletion and
  // disable/reset cannot leave a stale assignment or exposure behind.
  const [journey] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "MeasurementJourney"
    WHERE id = ${journeyId} AND test AND "expiresAt" > CURRENT_TIMESTAMP FOR SHARE
  `;
  if (!journey) return false;
  const [preference] = await db.$queryRaw<{ journeyId: string }[]>`
    SELECT "journeyId" FROM "RecommendationPreference"
    WHERE "journeyId" = ${journeyId} AND enabled AND "since" = ${since}
      AND "shopperKey" IS NOT DISTINCT FROM ${shopperKey} FOR UPDATE
  `;
  return Boolean(preference);
}

export async function enrollRecommendationExperiment(marketId: MarketId, journeyId: string, since: Date, shopperKey: string | null): Promise<RecommendationExperiment | null> {
  if (!recommendationExperimentEnabled()) return null;
  const experimentId = plan.id;
  return getDb().$transaction(async db => {
    if (!await lockExperimentPreference(db, journeyId, since, shopperKey)) return null;
    const row = await db.recommendationExperimentAssignment.upsert({
      where: { experimentId_marketId_journeyId: { experimentId, marketId, journeyId } },
      create: { id: stableMeasurementId("experiment-assignment", experimentId, marketId, journeyId, since.toISOString()),
        experimentId, marketId, journeyId, preferenceSince: since, variant: recommendationExperimentVariant(marketId, journeyId) },
      update: {},
      select: { id: true, variant: true, preferenceSince: true },
    });
    return +row.preferenceSince === +since ? { id: row.id, experimentId, variant: row.variant } : null;
  });
}

export async function recordRecommendationExperimentLatency(id: string, durationMs: number) {
  if (!recommendationExperimentEnabled() || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 120_000) return;
  await getDb().recommendationExperimentAssignment.updateMany({
    where: { id, experimentId: plan.id, latencyMs: null }, data: { latencyMs: Math.round(durationMs) },
  });
}

export async function deleteRecommendationExperimentHistory(journeyId: string, db?: DbReader): Promise<void> {
  if (!db) return getDb().$transaction(tx => deleteRecommendationExperimentHistory(journeyId, tx));
  await db.measurementEvent.deleteMany({ where: { journeyId, kind: "EXPERIMENT_EXPOSURE" } });
  await db.measurementEvent.updateMany({ where: { journeyId, experimentAssignment: { not: null } },
    data: { experimentAssignment: null, recommendationVersion: null } });
  await db.recommendationExperimentAssignment.deleteMany({ where: { journeyId } });
}
