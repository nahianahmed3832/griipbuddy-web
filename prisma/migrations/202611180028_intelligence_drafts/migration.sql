CREATE TYPE "IntelligenceDraftKind" AS ENUM ('COLLECTION', 'PRODUCT_TEST', 'PURCHASING');
CREATE TYPE "IntelligenceOutcome" AS ENUM ('POSITIVE', 'NEGATIVE', 'INCONCLUSIVE');

CREATE TABLE "IntelligenceDraft" (
    "id" CHAR(64) NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "test" BOOLEAN NOT NULL,
    "kind" "IntelligenceDraftKind" NOT NULL,
    "sourceId" VARCHAR(120) NOT NULL,
    "from" DATE NOT NULL,
    "through" DATE NOT NULL,
    "actorId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntelligenceDraft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntelligenceDraft_window_check" CHECK ("from" <= "through")
);
CREATE INDEX "IntelligenceDraft_marketId_test_createdAt_idx"
    ON "IntelligenceDraft" ("marketId", "test", "createdAt");

CREATE TABLE "IntelligenceDraftObservation" (
    "id" CHAR(64) NOT NULL,
    "draftId" CHAR(64) NOT NULL,
    "actorId" TEXT NOT NULL,
    "result" "IntelligenceOutcome" NOT NULL,
    "from" DATE NOT NULL,
    "through" DATE NOT NULL,
    "note" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntelligenceDraftObservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IntelligenceDraftObservation_window_check" CHECK ("from" <= "through"),
    CONSTRAINT "IntelligenceDraftObservation_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "IntelligenceDraft" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "IntelligenceDraftObservation_draftId_createdAt_idx"
    ON "IntelligenceDraftObservation" ("draftId", "createdAt");
