ALTER TYPE "MeasurementKind" ADD VALUE 'EXPERIMENT_EXPOSURE';
ALTER TABLE "MeasurementEvent" ADD COLUMN "recommendationVersion" VARCHAR(100);
CREATE INDEX "MeasurementEvent_experimentAssignment_kind_idx" ON "MeasurementEvent"("experimentAssignment", "kind");

CREATE TYPE "RecommendationExperimentVariant" AS ENUM ('control', 'personalized');
CREATE TABLE "RecommendationExperimentAssignment" (
    "id" VARCHAR(64) NOT NULL,
    "experimentId" VARCHAR(64) NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "journeyId" VARCHAR(64) NOT NULL,
    "variant" "RecommendationExperimentVariant" NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preferenceSince" TIMESTAMP(3) NOT NULL,
    "latencyMs" INTEGER,
    CONSTRAINT "RecommendationExperimentAssignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RecommendationExperimentAssignment_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "MeasurementJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RecommendationExperimentAssignment_unit_key" ON "RecommendationExperimentAssignment"("experimentId", "marketId", "journeyId");
CREATE INDEX "RecommendationExperimentAssignment_journeyId_idx" ON "RecommendationExperimentAssignment"("journeyId");
CREATE INDEX "RecommendationExperimentAssignment_cohort_idx" ON "RecommendationExperimentAssignment"("marketId", "experimentId", "assignedAt");
