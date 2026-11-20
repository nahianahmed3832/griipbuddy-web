CREATE TYPE "SellerPreparationStatus" AS ENUM ('PREPARING', 'READY', 'HANDED_OFF');

CREATE TABLE "MarketplaceSellerFulfillment" (
    "orderId" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "status" "SellerPreparationStatus" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceSellerFulfillment_pkey" PRIMARY KEY ("orderId", "shopId")
);

CREATE INDEX "MarketplaceSellerFulfillment_shopId_idx" ON "MarketplaceSellerFulfillment"("shopId");

ALTER TABLE "MarketplaceSellerFulfillment" ADD CONSTRAINT "MarketplaceSellerFulfillment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketplaceSellerFulfillment" ADD CONSTRAINT "MarketplaceSellerFulfillment_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
