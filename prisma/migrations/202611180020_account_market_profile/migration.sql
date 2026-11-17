CREATE TABLE "ShopperMarketProfile" (
  "shopperId" TEXT NOT NULL REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "marketId" "MarketCode" NOT NULL,
  "displayName" VARCHAR(65),
  "language" VARCHAR(2) NOT NULL DEFAULT 'en',
  "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopperMarketProfile_pkey" PRIMARY KEY ("shopperId", "marketId"),
  CONSTRAINT "ShopperMarketProfile_language_check" CHECK ("language" = 'en' OR ("language" = 'bn' AND "marketId" = 'bd'))
);

CREATE TABLE "ShopperAccountEvent" (
  "id" UUID NOT NULL,
  "shopperId" TEXT NOT NULL REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "marketId" "MarketCode" NOT NULL,
  "action" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopperAccountEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShopperAccountEvent_shopperId_marketId_createdAt_idx" ON "ShopperAccountEvent"("shopperId", "marketId", "createdAt");
