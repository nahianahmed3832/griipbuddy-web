ALTER TABLE "Order"
  ADD COLUMN "shippingWarehouseId" VARCHAR(24),
  ADD COLUMN "shippingWarehouseName" VARCHAR(120),
  ADD CONSTRAINT "Order_shippingWarehouse_snapshot_check" CHECK (
    ("shippingWarehouseId" IS NULL AND "shippingWarehouseName" IS NULL) OR
    ("shippingWarehouseId" IS NOT NULL AND "shippingWarehouseName" IS NOT NULL
      AND "shippingWarehouseId" ~ '^[a-f0-9]{24}$' AND length(trim("shippingWarehouseName")) > 0)
  );

CREATE INDEX "Order_shippingWarehouseId_createdAt_idx" ON "Order" ("shippingWarehouseId", "createdAt");
