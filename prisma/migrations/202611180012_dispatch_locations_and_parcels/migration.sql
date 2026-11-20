CREATE TYPE "OrderParcelStatus" AS ENUM ('PLANNED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REFUSED', 'RETURNED');

CREATE TABLE "DispatchLocation" (
  "id" TEXT PRIMARY KEY,
  "name" VARCHAR(120) NOT NULL,
  "marketId" "MarketCode",
  "shopId" UUID,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "priority" INTEGER NOT NULL DEFAULT 100,
  CONSTRAINT "DispatchLocation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DispatchLocation_market_check" CHECK (
    ("id" = 'legacy-primary' AND "marketId" IS NULL AND "shopId" IS NULL)
    OR ("id" <> 'legacy-primary' AND "marketId" IS NOT NULL)
  )
);

INSERT INTO "DispatchLocation" ("id", "name", "priority") VALUES ('legacy-primary', 'Shared dispatch', 100);

CREATE INDEX "DispatchLocation_marketId_active_priority_idx" ON "DispatchLocation" ("marketId", "active", "priority");
CREATE INDEX "DispatchLocation_shopId_idx" ON "DispatchLocation" ("shopId");

CREATE TABLE "LocationInventory" (
  "variantId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "available" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LocationInventory_pkey" PRIMARY KEY ("variantId", "locationId"),
  CONSTRAINT "LocationInventory_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LocationInventory_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "DispatchLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "LocationInventory_available_check" CHECK ("available" >= 0),
  CONSTRAINT "LocationInventory_location_check" CHECK ("locationId" <> 'legacy-primary')
);

CREATE INDEX "LocationInventory_locationId_idx" ON "LocationInventory" ("locationId");

ALTER TABLE "PayPalCheckout" ADD COLUMN "stockAllocations" JSONB;
ALTER TABLE "PrepaidCheckout" ADD COLUMN "stockAllocations" JSONB;

CREATE TABLE "OrderParcel" (
  "id" UUID PRIMARY KEY,
  "orderId" UUID NOT NULL,
  "locationId" TEXT NOT NULL,
  "locationName" VARCHAR(120) NOT NULL,
  "status" "OrderParcelStatus" NOT NULL DEFAULT 'PLANNED',
  "carrier" VARCHAR(60),
  "trackingReference" VARCHAR(80),
  "source" "BangladeshShipmentSource",
  "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedAt" TIMESTAMP(3),
  "returnDisposition" "BangladeshReturnDisposition",
  CONSTRAINT "OrderParcel_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderParcel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "DispatchLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderParcel_tracking_check" CHECK (
    ("status" = 'PLANNED' AND "carrier" IS NULL AND "trackingReference" IS NULL AND "source" IS NULL)
    OR ("status" <> 'PLANNED' AND "carrier" IS NOT NULL AND "trackingReference" IS NOT NULL AND "source" IS NOT NULL)
  ),
  CONSTRAINT "OrderParcel_return_receipt_check" CHECK (
    ("status" = 'RETURNED' AND "receivedAt" IS NOT NULL AND "returnDisposition" IS NOT NULL)
    OR ("status" <> 'RETURNED' AND "receivedAt" IS NULL AND "returnDisposition" IS NULL)
  )
);

CREATE UNIQUE INDEX "OrderParcel_orderId_locationId_key" ON "OrderParcel" ("orderId", "locationId");
CREATE UNIQUE INDEX "OrderParcel_orderId_trackingReference_key" ON "OrderParcel" ("orderId", "trackingReference");
CREATE INDEX "OrderParcel_locationId_idx" ON "OrderParcel" ("locationId");

CREATE TABLE "OrderParcelItem" (
  "parcelId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "OrderParcelItem_pkey" PRIMARY KEY ("parcelId", "orderItemId"),
  CONSTRAINT "OrderParcelItem_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "OrderParcel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderParcelItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderParcelItem_quantity_check" CHECK ("quantity" > 0)
);

CREATE INDEX "OrderParcelItem_orderItemId_idx" ON "OrderParcelItem" ("orderItemId");

CREATE TABLE "OrderParcelEvent" (
  "parcelId" UUID NOT NULL,
  "status" "OrderParcelStatus" NOT NULL,
  "actorId" TEXT,
  "evidence" VARCHAR(200),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderParcelEvent_pkey" PRIMARY KEY ("parcelId", "status"),
  CONSTRAINT "OrderParcelEvent_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "OrderParcel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
