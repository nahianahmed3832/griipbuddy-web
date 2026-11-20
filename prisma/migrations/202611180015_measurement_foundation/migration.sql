ALTER TYPE "MeasurementKind" ADD VALUE 'PRODUCT_IMPRESSION';
ALTER TYPE "MeasurementKind" ADD VALUE 'SECTION_IMPRESSION';
ALTER TYPE "MeasurementKind" ADD VALUE 'PRODUCT_CLICK';
ALTER TYPE "MeasurementKind" ADD VALUE 'SEARCH';
ALTER TYPE "MeasurementKind" ADD VALUE 'SEARCH_FILTER';
ALTER TYPE "MeasurementKind" ADD VALUE 'CART_UPDATE';
ALTER TYPE "MeasurementKind" ADD VALUE 'CART_REMOVE';
ALTER TYPE "MeasurementKind" ADD VALUE 'WISHLIST_ADD';
ALTER TYPE "MeasurementKind" ADD VALUE 'WISHLIST_REMOVE';
ALTER TYPE "MeasurementKind" ADD VALUE 'CHECKOUT_STEP';
ALTER TYPE "MeasurementKind" ADD VALUE 'CHECKOUT_FAILURE';
ALTER TYPE "MeasurementKind" ADD VALUE 'ACCOUNT_ASSOCIATED';

ALTER TABLE "MeasurementEvent"
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sessionId" UUID,
  ADD COLUMN "accountKey" VARCHAR(64),
  ADD COLUMN "campaignSource" VARCHAR(32),
  ADD COLUMN "amountMinor" INTEGER,
  ADD COLUMN "currency" "CurrencyCode",
  ADD COLUMN "placement" VARCHAR(100),
  ADD COLUMN "position" INTEGER,
  ADD COLUMN "homepageConfig" VARCHAR(100),
  ADD COLUMN "experimentAssignment" VARCHAR(100),
  ADD COLUMN "details" JSONB,
  ADD COLUMN "receivedAt" TIMESTAMP(3);

UPDATE "MeasurementEvent" SET "receivedAt" = "at";
ALTER TABLE "MeasurementEvent" ALTER COLUMN "receivedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "receivedAt" SET NOT NULL;
CREATE INDEX "MeasurementEvent_marketId_at_idx" ON "MeasurementEvent"("marketId", "at");

ALTER TABLE "MeasurementOrder" ADD COLUMN "sessionId" UUID;

CREATE TABLE "MeasurementAttempt" (
  "attemptId" UUID PRIMARY KEY REFERENCES "CheckoutAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "journeyId" VARCHAR(64) NOT NULL REFERENCES "MeasurementJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "marketId" "MarketCode" NOT NULL,
  "sessionId" UUID NOT NULL
);
CREATE INDEX "MeasurementAttempt_journeyId_idx" ON "MeasurementAttempt"("journeyId");

ALTER TABLE "PayPalCheckout"
  ADD COLUMN "providerFailedAt" TIMESTAMP(3),
  ADD COLUMN "providerFailureCode" VARCHAR(24);
CREATE INDEX "PayPalCheckout_providerFailedAt_idx" ON "PayPalCheckout"("providerFailedAt");

ALTER TABLE "PrepaidCheckout"
  ADD COLUMN "providerFailedAt" TIMESTAMP(3),
  ADD COLUMN "providerFailureCode" VARCHAR(24);
CREATE INDEX "PrepaidCheckout_providerFailedAt_idx" ON "PrepaidCheckout"("providerFailedAt");
