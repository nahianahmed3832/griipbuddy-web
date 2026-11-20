CREATE TABLE "ShopperLegacyLink" (
  "shopperId" TEXT NOT NULL PRIMARY KEY REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "legacyCustomerId" VARCHAR(24) NOT NULL UNIQUE,
  "marketId" "MarketCode" NOT NULL,
  "proofOperationId" UUID NOT NULL UNIQUE,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopperLegacyLink_legacy_id_check" CHECK ("legacyCustomerId" ~ '^[a-f0-9]{24}$'),
  CONSTRAINT "ShopperLegacyLink_market_check" CHECK ("marketId" = 'bd')
);
