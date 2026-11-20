-- Before this migration only the original BDT checkout could redeem these coupons.
ALTER TABLE "MarketplaceCoupon" ADD COLUMN "marketId" "MarketCode" NOT NULL DEFAULT 'bd';
CREATE INDEX "MarketplaceCoupon_marketId_createdAt_idx" ON "MarketplaceCoupon" ("marketId", "createdAt");
