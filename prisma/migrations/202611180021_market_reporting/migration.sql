CREATE TABLE "OrderContributionEvidence" (
  "orderId" UUID PRIMARY KEY REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "currency" "CurrencyCode" NOT NULL,
  "source" VARCHAR(64) NOT NULL CHECK (length(trim("source")) > 0),
  "verifiedThrough" TIMESTAMP(3) NOT NULL,
  "revenueBeforeRefundsMinor" INTEGER CHECK ("revenueBeforeRefundsMinor" >= 0),
  "refundsMinor" INTEGER CHECK ("refundsMinor" >= 0),
  "itemCostMinor" INTEGER CHECK ("itemCostMinor" >= 0),
  "packagingMinor" INTEGER CHECK ("packagingMinor" >= 0),
  "outboundMinor" INTEGER CHECK ("outboundMinor" >= 0),
  "returnMinor" INTEGER CHECK ("returnMinor" >= 0),
  "paymentFeesMinor" INTEGER CHECK ("paymentFeesMinor" >= 0)
);
CREATE INDEX "Order_marketId_measurementTest_createdAt_idx" ON "Order" ("marketId", "measurementTest", "createdAt");
