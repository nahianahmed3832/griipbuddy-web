ALTER TABLE "MeasurementJourney" ADD COLUMN "automated" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ProductIntelligenceSnapshot" (
    "marketId" "MarketCode" NOT NULL,
    "test" BOOLEAN NOT NULL,
    "variantId" TEXT NOT NULL,
    "slot" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "priceMinor" INTEGER NOT NULL CHECK ("priceMinor" >= 0),
    "discountMinor" INTEGER NOT NULL CHECK ("discountMinor" BETWEEN 0 AND "priceMinor"),
    "available" INTEGER CHECK ("available" >= 0),
    "deliveryAvailable" BOOLEAN,
    "source" VARCHAR(32) NOT NULL,

    CONSTRAINT "ProductIntelligenceSnapshot_pkey" PRIMARY KEY ("marketId", "test", "variantId", "slot"),
    CONSTRAINT "ProductIntelligenceSnapshot_observation_check" CHECK ("observedAt" >= "slot" AND "observedAt" < "slot" + interval '1 hour')
);

CREATE INDEX "ProductIntelligenceSnapshot_window_idx" ON "ProductIntelligenceSnapshot" ("marketId", "test", "observedAt");
