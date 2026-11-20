ALTER TYPE "OrderCaseKind" ADD VALUE 'CANCEL';
ALTER TYPE "OrderCaseKind" ADD VALUE 'EXCHANGE';
ALTER TYPE "OrderCaseStatus" ADD VALUE 'PICKUP_SCHEDULED';
ALTER TYPE "OrderCaseStatus" ADD VALUE 'REFUND_APPROVED';
ALTER TYPE "OrderCaseStatus" ADD VALUE 'EXCHANGE_SHIPPED';

ALTER TABLE "OrderCase"
  ADD COLUMN "pickupAt" TIMESTAMP(3),
  ADD COLUMN "pickupReference" VARCHAR(80),
  ADD COLUMN "refundAmountMinor" INTEGER,
  ADD COLUMN "replacementTrackingReference" VARCHAR(80),
  DROP CONSTRAINT "OrderCase_return_receipt_fields",
  ADD CONSTRAINT "OrderCase_return_receipt_fields" CHECK (
    ("returnReceivedAt" IS NULL AND "returnReceivedById" IS NULL AND "returnDisposition" IS NULL)
    OR ("kind"::text IN ('RETURN', 'EXCHANGE') AND "returnReceivedAt" IS NOT NULL AND "returnDisposition" IS NOT NULL)
  ),
  ADD CONSTRAINT "OrderCase_pickup_fields" CHECK (
    ("pickupAt" IS NULL AND "pickupReference" IS NULL)
    OR ("kind"::text IN ('RETURN', 'EXCHANGE') AND "pickupAt" IS NOT NULL AND "pickupReference" IS NOT NULL)
  ),
  ADD CONSTRAINT "OrderCase_refund_amount" CHECK (
    "refundAmountMinor" IS NULL OR ("kind"::text IN ('RETURN', 'CANCEL') AND "refundAmountMinor" > 0)
  ),
  ADD CONSTRAINT "OrderCase_replacement_reference" CHECK (
    "replacementTrackingReference" IS NULL OR ("kind"::text = 'EXCHANGE' AND "returnReceivedAt" IS NOT NULL)
  );

ALTER TABLE "OrderCaseReturnLine"
  ADD COLUMN "replacementVariantId" TEXT,
  ADD COLUMN "replacementVariantName" TEXT,
  ADD CONSTRAINT "OrderCaseReturnLine_replacementVariantId_fkey" FOREIGN KEY ("replacementVariantId")
    REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OrderCaseReturnLine_replacement_fields" CHECK (
    ("replacementVariantId" IS NULL AND "replacementVariantName" IS NULL)
    OR ("replacementVariantId" IS NOT NULL AND "replacementVariantName" IS NOT NULL)
  );

CREATE INDEX "OrderCaseReturnLine_replacementVariantId_idx" ON "OrderCaseReturnLine"("replacementVariantId");
