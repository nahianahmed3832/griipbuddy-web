ALTER TYPE "OrderCaseKind" ADD VALUE IF NOT EXISTS 'CANCEL';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BD_CASE_REFUND_CONFIRMED';

ALTER TABLE "OrderCase"
ADD COLUMN "reason" VARCHAR(32),
ADD COLUMN "issueItemId" UUID,
ADD COLUMN "refundAmountMinor" INTEGER,
ADD COLUMN "refundMethod" VARCHAR(60),
ADD COLUMN "refundReference" VARCHAR(80),
ADD COLUMN "refundConfirmedAt" TIMESTAMP(3);

ALTER TABLE "OrderCase"
ADD CONSTRAINT "OrderCase_issueItemId_fkey" FOREIGN KEY ("issueItemId")
REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "OrderCase_refund_complete" CHECK (
  ("refundAmountMinor" IS NULL AND "refundMethod" IS NULL AND "refundReference" IS NULL AND "refundConfirmedAt" IS NULL)
  OR ("refundAmountMinor" IS NOT NULL AND "refundAmountMinor" > 0 AND
      "refundMethod" IS NOT NULL AND "refundReference" IS NOT NULL AND "refundConfirmedAt" IS NOT NULL)
);

CREATE TABLE "OrderCaseAttachment" (
  "caseId" UUID NOT NULL,
  "data" BYTEA NOT NULL,
  CONSTRAINT "OrderCaseAttachment_pkey" PRIMARY KEY ("caseId"),
  CONSTRAINT "OrderCaseAttachment_caseId_fkey" FOREIGN KEY ("caseId")
    REFERENCES "OrderCase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "OrderCaseEvent"
ADD COLUMN "shopperActorId" TEXT,
ADD COLUMN "refundConfirmed" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "OrderCase_orderId_refundMethod_refundReference_key"
ON "OrderCase"("orderId", "refundMethod", "refundReference");
