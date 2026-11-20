ALTER TABLE "Collection"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "defaultPublished" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "CollectionMarketPublication" (
  "collectionId" TEXT NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "published" BOOLEAN NOT NULL,
  CONSTRAINT "CollectionMarketPublication_pkey" PRIMARY KEY ("collectionId", "marketId"),
  CONSTRAINT "CollectionMarketPublication_collectionId_fkey"
    FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "CollectionMarketPublication_marketId_published_idx" ON "CollectionMarketPublication" ("marketId", "published");

ALTER TABLE "CollectionProduct"
  ADD COLUMN "position" INTEGER,
  ADD CONSTRAINT "CollectionProduct_position_check" CHECK ("position" >= 0);
CREATE INDEX "CollectionProduct_collectionId_position_idx" ON "CollectionProduct" ("collectionId", "position");

ALTER TABLE "MarketMenu" ADD COLUMN "locale" VARCHAR(35) NOT NULL DEFAULT '';
CREATE UNIQUE INDEX "MarketMenu_marketId_key_locale_key" ON "MarketMenu" ("marketId", "key", "locale");
DROP INDEX "MarketMenu_marketId_key_key";

ALTER TABLE "MarketMenuItem"
  ADD COLUMN "label" VARCHAR(80),
  ADD COLUMN "visible" BOOLEAN NOT NULL DEFAULT true;
