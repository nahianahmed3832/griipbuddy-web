ALTER TABLE "Order" ADD COLUMN "measurementTest" BOOLEAN;

CREATE TYPE "MeasurementKind" AS ENUM ('PRODUCT_VIEW', 'CART_ADD', 'CHECKOUT_START');

CREATE TABLE "MeasurementJourney" (
  "id" VARCHAR(64) PRIMARY KEY,
  "test" BOOLEAN NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "MeasurementEvent" (
  "id" VARCHAR(64) PRIMARY KEY,
  "journeyId" VARCHAR(64) NOT NULL REFERENCES "MeasurementJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" "MeasurementKind" NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "productId" VARCHAR(100),
  "variantId" VARCHAR(100),
  "quantity" INTEGER,
  "campaign" VARCHAR(64),
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "MeasurementOrder" (
  "orderId" UUID PRIMARY KEY REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "journeyId" VARCHAR(64) NOT NULL REFERENCES "MeasurementJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MeasurementJourney_expiresAt_idx" ON "MeasurementJourney"("expiresAt");
CREATE INDEX "MeasurementEvent_journeyId_marketId_kind_at_idx" ON "MeasurementEvent"("journeyId", "marketId", "kind", "at");
CREATE INDEX "MeasurementEvent_at_id_idx" ON "MeasurementEvent"("at", "id");
CREATE INDEX "MeasurementOrder_journeyId_idx" ON "MeasurementOrder"("journeyId");
