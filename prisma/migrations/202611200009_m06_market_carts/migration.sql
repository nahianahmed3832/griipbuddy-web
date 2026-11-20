ALTER TABLE "CheckoutAttempt"
  ADD COLUMN "cartSource" VARCHAR(12),
  ADD COLUMN "cartRevision" INTEGER;

CREATE TABLE "ShopperMarketCart" (
  "shopperId" TEXT NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "items" JSONB NOT NULL DEFAULT '[]',
  "saved" JSONB NOT NULL DEFAULT '[]',
  "lots" JSONB NOT NULL DEFAULT '{}',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopperMarketCart_pkey" PRIMARY KEY ("shopperId", "marketId"),
  CONSTRAINT "ShopperMarketCart_shopperId_fkey" FOREIGN KEY ("shopperId")
    REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ShopperMarketCartOperation" (
  "shopperId" TEXT NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "purchase" BOOLEAN NOT NULL DEFAULT false,
  "operationId" UUID NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopperMarketCartOperation_pkey" PRIMARY KEY ("shopperId", "marketId", "purchase", "operationId"),
  CONSTRAINT "ShopperMarketCartOperation_shopperId_marketId_fkey" FOREIGN KEY ("shopperId", "marketId")
    REFERENCES "ShopperMarketCart"("shopperId", "marketId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Keep the old rows and receipts. Copy only identities backed by a matching
-- variant and market currency. Legacy price-free references have no provenance.
WITH entries AS (
  SELECT cart."shopperId", cart."revision", cart."updatedAt", offer."marketId", part.saved, line.value, line.position
  FROM "ShopperCart" AS cart
  CROSS JOIN LATERAL (VALUES (false, cart.items), (true, cart.saved)) AS part(saved, body)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(part.body) = 'array' THEN part.body ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS line(value, position)
  JOIN "MarketOffer" AS offer
    ON offer."variantId" = line.value->>'variantId'
    AND offer."offerId"::text = line.value->>'offerId'
    AND (
      (offer."marketId" = 'bd' AND offer."currency" = 'BDT')
      OR (offer."marketId" = 'us' AND offer."currency" = 'USD')
    )
)
INSERT INTO "ShopperMarketCart" ("shopperId", "marketId", "items", "saved", "revision", "updatedAt")
SELECT "shopperId", "marketId",
  COALESCE(jsonb_agg(value ORDER BY position) FILTER (WHERE NOT saved), '[]'::jsonb),
  COALESCE(jsonb_agg(value ORDER BY position) FILTER (WHERE saved), '[]'::jsonb),
  MAX("revision"), MAX("updatedAt")
FROM entries
GROUP BY "shopperId", "marketId";
