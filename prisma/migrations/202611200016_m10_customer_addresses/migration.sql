CREATE TYPE "ShopperAddressKind" AS ENUM ('SHIPPING', 'BILLING');

ALTER TABLE "ShopperAddress"
  ADD COLUMN "marketId" "MarketCode" NOT NULL DEFAULT 'bd',
  ADD COLUMN "kind" "ShopperAddressKind" NOT NULL DEFAULT 'SHIPPING',
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ShopperAddress" SET "marketId" = 'us'
WHERE "details"->>'country' = 'US';

CREATE INDEX "ShopperAddress_shopperId_marketId_kind_createdAt_idx"
  ON "ShopperAddress" ("shopperId", "marketId", "kind", "createdAt");

CREATE UNIQUE INDEX "ShopperAddress_default_per_market_kind"
  ON "ShopperAddress" ("shopperId", "marketId", "kind") WHERE "isDefault";

DROP INDEX "ShopperAddress_shopperId_createdAt_idx";
