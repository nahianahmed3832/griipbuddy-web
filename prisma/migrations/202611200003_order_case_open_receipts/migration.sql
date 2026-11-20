ALTER TABLE "OrderCase"
  ADD COLUMN "openRequestId" UUID,
  ADD COLUMN "openRequestDigest" CHAR(64),
  ADD CONSTRAINT "OrderCase_open_request_complete_check" CHECK (
    ("openRequestId" IS NULL AND "openRequestDigest" IS NULL) OR
    ("openRequestId" IS NOT NULL AND "openRequestDigest" IS NOT NULL AND "openRequestDigest" ~ '^[a-f0-9]{64}$')
  );

CREATE UNIQUE INDEX "OrderCase_orderId_openRequestId_key" ON "OrderCase"("orderId", "openRequestId");
