CREATE TABLE "RecommendationPreference" (
    "journeyId" VARCHAR(64) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shopperKey" VARCHAR(64),
    "associatedAt" TIMESTAMP(3),
    CONSTRAINT "RecommendationPreference_pkey" PRIMARY KEY ("journeyId"),
    CONSTRAINT "RecommendationPreference_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "MeasurementJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RecommendationAccountReset" (
    "shopperId" TEXT NOT NULL,
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationAccountReset_pkey" PRIMARY KEY ("shopperId"),
    CONSTRAINT "RecommendationAccountReset_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
