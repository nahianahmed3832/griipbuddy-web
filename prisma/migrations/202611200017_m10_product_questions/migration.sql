ALTER TABLE "ShopperRequest" ADD COLUMN "productId" TEXT;

ALTER TABLE "ShopperRequest"
  ADD CONSTRAINT "ShopperRequest_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ShopperRequest_marketId_productId_updatedAt_idx"
  ON "ShopperRequest"("marketId", "productId", "updatedAt");
