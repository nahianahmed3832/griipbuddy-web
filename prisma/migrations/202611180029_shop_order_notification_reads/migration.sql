CREATE TABLE "ShopperOrderNotificationRead" (
  "shopperId" TEXT NOT NULL,
  "orderId" UUID NOT NULL,
  "eventKey" VARCHAR(64) NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopperOrderNotificationRead_pkey" PRIMARY KEY ("shopperId", "eventKey"),
  CONSTRAINT "ShopperOrderNotificationRead_shopperId_fkey"
    FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ShopperOrderNotificationRead_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ShopperOrderNotificationRead_orderId_idx" ON "ShopperOrderNotificationRead"("orderId");
