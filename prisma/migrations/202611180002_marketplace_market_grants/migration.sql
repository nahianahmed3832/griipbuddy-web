CREATE TYPE "MarketplaceMarketStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');
ALTER TYPE "AuditAction" ADD VALUE 'MARKETPLACE_GRANT_CHANGED';

CREATE TABLE "MarketplaceShopMarket" (
  "shopId" UUID NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "status" "MarketplaceMarketStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MarketplaceShopMarket_pkey" PRIMARY KEY ("shopId", "marketId"),
  CONSTRAINT "MarketplaceShopMarket_shopId_fkey" FOREIGN KEY ("shopId")
    REFERENCES "MarketplaceShop"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MarketplaceShopMarket_marketId_status_idx" ON "MarketplaceShopMarket"("marketId", "status");
