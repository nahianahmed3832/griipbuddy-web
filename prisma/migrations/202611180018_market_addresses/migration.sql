ALTER TABLE "ShopperAddress"
    ADD COLUMN "marketId" "MarketCode" NOT NULL DEFAULT 'bd',
    ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- The original address form accepted Bangladesh delivery addresses only.
UPDATE "ShopperAddress" AS address
SET "isDefault" = true
FROM (
    SELECT DISTINCT ON ("shopperId") "id" FROM "ShopperAddress"
    ORDER BY "shopperId", "createdAt" DESC, "id" DESC
) AS latest
WHERE address."id" = latest."id";

CREATE INDEX "ShopperAddress_owner_market_default_created_idx"
    ON "ShopperAddress" ("shopperId", "marketId", "isDefault", "createdAt");

CREATE UNIQUE INDEX "ShopperAddress_one_default_per_market"
    ON "ShopperAddress" ("shopperId", "marketId") WHERE "isDefault";
