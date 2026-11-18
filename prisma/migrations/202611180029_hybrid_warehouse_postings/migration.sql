CREATE TABLE "HybridWarehousePosting" (
    "key" VARCHAR(64) NOT NULL,
    "orderId" UUID NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "request" JSONB NOT NULL,
    "trackingReference" VARCHAR(80),
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "HybridWarehousePosting_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "HybridWarehousePosting_completion" CHECK (("evidence" IS NULL) = ("completedAt" IS NULL))
);

CREATE INDEX "HybridWarehousePosting_orderId_completedAt_idx" ON "HybridWarehousePosting"("orderId", "completedAt");

ALTER TABLE "HybridWarehousePosting" ADD CONSTRAINT "HybridWarehousePosting_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
