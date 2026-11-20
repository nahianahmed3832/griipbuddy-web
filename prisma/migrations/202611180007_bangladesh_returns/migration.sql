ALTER TYPE "OrderCaseStatus" ADD VALUE 'RETURN_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE 'BD_REFUSED_PARCEL_RECEIVED';
ALTER TYPE "AuditAction" ADD VALUE 'BD_RETURN_CASE_RECEIVED';

CREATE TYPE "BangladeshReturnDisposition" AS ENUM ('RESTOCK', 'HOLD');

ALTER TABLE "OrderCase"
  ADD COLUMN "returnReceivedAt" TIMESTAMP(3),
  ADD COLUMN "returnReceivedById" TEXT,
  ADD COLUMN "returnDisposition" "BangladeshReturnDisposition",
  ADD CONSTRAINT "OrderCase_returnReceivedById_fkey" FOREIGN KEY ("returnReceivedById")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "OrderCase_return_receipt_fields" CHECK (
    ("returnReceivedAt" IS NULL AND "returnReceivedById" IS NULL AND "returnDisposition" IS NULL)
    OR ("kind" = 'RETURN' AND "returnReceivedAt" IS NOT NULL AND "returnDisposition" IS NOT NULL)
  );

CREATE TABLE "BangladeshRefusedParcelReceipt" (
  "orderId" UUID NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedById" TEXT,
  "disposition" "BangladeshReturnDisposition" NOT NULL,
  "restockedUnits" INTEGER NOT NULL,
  "note" VARCHAR(500) NOT NULL,
  CONSTRAINT "BangladeshRefusedParcelReceipt_pkey" PRIMARY KEY ("orderId"),
  CONSTRAINT "BangladeshRefusedParcelReceipt_orderId_fkey" FOREIGN KEY ("orderId")
    REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BangladeshRefusedParcelReceipt_receivedById_fkey" FOREIGN KEY ("receivedById")
    REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BangladeshRefusedParcelReceipt_stock_check" CHECK (
    ("disposition" = 'RESTOCK' AND "restockedUnits" > 0)
    OR ("disposition" = 'HOLD' AND "restockedUnits" = 0)
  )
);

CREATE TABLE "OrderCaseReturnLine" (
  "caseId" UUID NOT NULL,
  "orderItemId" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  CONSTRAINT "OrderCaseReturnLine_pkey" PRIMARY KEY ("caseId", "orderItemId"),
  CONSTRAINT "OrderCaseReturnLine_caseId_fkey" FOREIGN KEY ("caseId")
    REFERENCES "OrderCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderCaseReturnLine_orderItemId_fkey" FOREIGN KEY ("orderItemId")
    REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderCaseReturnLine_quantity_check" CHECK ("quantity" > 0)
);

CREATE INDEX "OrderCaseReturnLine_orderItemId_idx" ON "OrderCaseReturnLine"("orderItemId");
