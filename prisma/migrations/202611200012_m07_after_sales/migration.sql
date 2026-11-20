ALTER TYPE "OrderCaseStatus" ADD VALUE 'CANCELLATION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_CASE_REFUND_PROCESSING';
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_CASE_REFUND_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'ORDER_CASE_REFUND_FAILED';
CREATE TYPE "OrderCaseRefundState" AS ENUM ('AUTHORIZED', 'PROCESSING', 'CONFIRMED', 'FAILED');

ALTER TABLE "OrderParcel" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "OrderParcelItem" ADD COLUMN "cancelledQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InventoryAllocation" ADD COLUMN "cancelledQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderCase" ADD COLUMN "cancellationAppliedAt" TIMESTAMP(3);
ALTER TABLE "OrderCaseEvent" ADD COLUMN "publicNote" TEXT;
ALTER TABLE "OrderCaseReturnLine" ADD COLUMN "settlementUnitOffset" INTEGER;
ALTER TABLE "OrderParcelItem" ADD CONSTRAINT "OrderParcelItem_cancelledQuantity_check"
  CHECK ("cancelledQuantity" >= 0 AND "cancelledQuantity" <= "quantity");
ALTER TABLE "InventoryAllocation" ADD CONSTRAINT "InventoryAllocation_cancelledQuantity_check"
  CHECK ("cancelledQuantity" >= 0 AND "cancelledQuantity" + "dispatched" <= "quantity");

CREATE TABLE "OrderCaseRefund" (
  "caseId" UUID NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "currency" "CurrencyCode" NOT NULL,
  "amountMinor" INTEGER NOT NULL CHECK ("amountMinor" > 0),
  "state" "OrderCaseRefundState" NOT NULL DEFAULT 'AUTHORIZED',
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "providerRefundId" VARCHAR(80),
  CONSTRAINT "OrderCaseRefund_pkey" PRIMARY KEY ("caseId"),
  CONSTRAINT "OrderCaseRefund_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OrderCase"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OrderCaseRefund_providerRefundId_key" ON "OrderCaseRefund"("providerRefundId");
