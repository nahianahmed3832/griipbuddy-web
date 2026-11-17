CREATE TYPE "ShopperMailStatus" AS ENUM ('CAPTURED', 'SENDING', 'SENT', 'FAILED');

CREATE TABLE "ShopperMailRecord" (
    "id" UUID NOT NULL,
    "deliveryKey" VARCHAR(180),
    "kind" VARCHAR(32) NOT NULL,
    "status" "ShopperMailStatus" NOT NULL,
    "recipient" VARCHAR(254),
    "subject" VARCHAR(160),
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShopperMailRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShopperMailRecord_preview_fields_check" CHECK (
      ("status" = 'CAPTURED' AND "recipient" IS NOT NULL AND "subject" IS NOT NULL AND "text" IS NOT NULL) OR
      ("status" <> 'CAPTURED' AND "recipient" IS NULL AND "subject" IS NULL AND "text" IS NULL AND "deliveryKey" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "ShopperMailRecord_deliveryKey_key" ON "ShopperMailRecord"("deliveryKey");
CREATE INDEX "ShopperMailRecord_recipient_createdAt_idx" ON "ShopperMailRecord"("recipient", "createdAt");
CREATE INDEX "ShopperMailRecord_status_createdAt_idx" ON "ShopperMailRecord"("status", "createdAt");
