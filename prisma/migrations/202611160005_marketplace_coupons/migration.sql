BEGIN;

ALTER TYPE "AuditAction" ADD VALUE 'COUPON_CHANGED';

CREATE TABLE "MarketplaceCoupon" (
    "code" VARCHAR(32) NOT NULL PRIMARY KEY,
    "shopId" UUID,
    "kind" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "minimumMinor" INTEGER NOT NULL DEFAULT 0,
    "useLimit" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MarketplaceCoupon_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MarketplaceCoupon_value_check" CHECK (
      ("kind" = 'PERCENT' AND "value" BETWEEN 1 AND 10000) OR
      ("kind" = 'FIXED' AND "value" BETWEEN 1 AND 10000000)
    ),
    CONSTRAINT "MarketplaceCoupon_minimum_check" CHECK ("minimumMinor" BETWEEN 0 AND 10000000),
    CONSTRAINT "MarketplaceCoupon_useLimit_check" CHECK ("useLimit" IS NULL OR "useLimit" BETWEEN 1 AND 100000),
    CONSTRAINT "MarketplaceCoupon_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{2,31}$')
);
CREATE INDEX "MarketplaceCoupon_shopId_idx" ON "MarketplaceCoupon"("shopId");

ALTER TABLE "Order" ADD COLUMN "couponCode" VARCHAR(32), ADD COLUMN "couponDiscountMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "couponDiscountMinor" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "Order_couponCode_idx" ON "Order"("couponCode");

COMMIT;
