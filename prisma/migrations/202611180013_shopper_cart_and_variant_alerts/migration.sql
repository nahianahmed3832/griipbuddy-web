CREATE TABLE "ShopperCart" (
  "shopperId" TEXT PRIMARY KEY,
  "items" JSONB NOT NULL DEFAULT '[]',
  "saved" JSONB NOT NULL DEFAULT '[]',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopperCart_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ShopperCart_items_check" CHECK (jsonb_typeof("items") = 'array' AND jsonb_typeof("saved") = 'array' AND "revision" >= 0)
);

CREATE TABLE "ShopperCartOperation" (
  "shopperId" TEXT NOT NULL,
  "operationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopperCartOperation_pkey" PRIMARY KEY ("shopperId", "operationId"),
  CONSTRAINT "ShopperCartOperation_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "ShopperCart"("shopperId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TYPE "VariantWatchEventKind" AS ENUM ('BACK_IN_STOCK', 'PRICE_DROP');

CREATE TABLE "ShopperVariantWatch" (
  "id" UUID PRIMARY KEY,
  "shopperId" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "backInStock" BOOLEAN NOT NULL DEFAULT false,
  "priceDrop" BOOLEAN NOT NULL DEFAULT false,
  "lastAvailable" BOOLEAN,
  "lastPriceMinor" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopperVariantWatch_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ShopperVariantWatch_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ShopperVariantWatch_price_check" CHECK ("lastPriceMinor" IS NULL OR "lastPriceMinor" >= 0)
);

CREATE UNIQUE INDEX "ShopperVariantWatch_shopperId_variantId_marketId_key" ON "ShopperVariantWatch" ("shopperId", "variantId", "marketId");

CREATE TABLE "ShopperVariantWatchEvent" (
  "id" UUID PRIMARY KEY,
  "watchId" UUID NOT NULL,
  "kind" "VariantWatchEventKind" NOT NULL,
  "amountMinor" INTEGER,
  "previousAmountMinor" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopperVariantWatchEvent_watchId_fkey" FOREIGN KEY ("watchId") REFERENCES "ShopperVariantWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ShopperVariantWatchEvent_amounts_check" CHECK (
    ("kind" = 'BACK_IN_STOCK' AND "previousAmountMinor" IS NULL AND ("amountMinor" IS NULL OR "amountMinor" >= 0))
    OR ("kind" = 'PRICE_DROP' AND "amountMinor" IS NOT NULL AND "previousAmountMinor" IS NOT NULL AND "amountMinor" >= 0 AND "previousAmountMinor" > "amountMinor")
  )
);

CREATE INDEX "ShopperVariantWatchEvent_watchId_createdAt_idx" ON "ShopperVariantWatchEvent" ("watchId", "createdAt");
