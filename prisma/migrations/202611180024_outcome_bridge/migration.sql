CREATE TYPE "BridgeOutcomeKind" AS ENUM ('ORDER_ACCEPTED', 'ORDER_DELIVERED', 'COD_COLLECTED', 'COD_REMITTED');

CREATE TABLE "BridgeOrder" (
    "id" VARCHAR(64) NOT NULL,
    "authority" VARCHAR(64) NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "evidence" "CommerceEvidence" NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "subtotalMinor" INTEGER,
    "discountMinor" INTEGER,
    "taxMinor" INTEGER,
    "deliveryMinor" INTEGER,
    "totalMinor" INTEGER NOT NULL,
    "lines" JSONB,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "measurementClaimed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "BridgeOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BridgeOrder_marketId_evidence_createdAt_idx" ON "BridgeOrder"("marketId", "evidence", "createdAt");

CREATE TABLE "BridgeOutcome" (
    "id" VARCHAR(64) NOT NULL,
    "orderId" VARCHAR(64) NOT NULL,
    "kind" "BridgeOutcomeKind" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "amountMinor" INTEGER,
    "grossMinor" INTEGER,
    "deductionsMinor" INTEGER,
    CONSTRAINT "BridgeOutcome_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BridgeOutcome_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BridgeOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BridgeOutcome_orderId_kind_key" ON "BridgeOutcome"("orderId", "kind");

CREATE TABLE "BridgeMeasurement" (
    "id" VARCHAR(64) NOT NULL,
    "authority" VARCHAR(64) NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "journeyId" VARCHAR(64) NOT NULL,
    "sessionId" UUID NOT NULL,
    "cartDigest" VARCHAR(64) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "orderId" VARCHAR(64),
    CONSTRAINT "BridgeMeasurement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BridgeMeasurement_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "MeasurementJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BridgeMeasurement_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BridgeOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BridgeMeasurement_orderId_key" ON "BridgeMeasurement"("orderId");
CREATE INDEX "BridgeMeasurement_journeyId_idx" ON "BridgeMeasurement"("journeyId");
