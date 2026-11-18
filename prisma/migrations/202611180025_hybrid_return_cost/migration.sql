CREATE TABLE "HybridReturnCost" (
    "id" UUID NOT NULL,
    "caseId" UUID,
    "refusedOrderId" UUID,
    "amountMinor" INTEGER NOT NULL,
    "evidenceReference" VARCHAR(120) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HybridReturnCost_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HybridReturnCost_one_receipt_check" CHECK (num_nonnulls("caseId", "refusedOrderId") = 1),
    CONSTRAINT "HybridReturnCost_nonnegative_check" CHECK ("amountMinor" >= 0),
    CONSTRAINT "HybridReturnCost_evidence_check" CHECK (char_length(btrim("evidenceReference")) >= 3)
);

CREATE UNIQUE INDEX "HybridReturnCost_caseId_key" ON "HybridReturnCost"("caseId");
CREATE UNIQUE INDEX "HybridReturnCost_refusedOrderId_key" ON "HybridReturnCost"("refusedOrderId");

ALTER TABLE "HybridReturnCost" ADD CONSTRAINT "HybridReturnCost_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "OrderCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HybridReturnCost" ADD CONSTRAINT "HybridReturnCost_refusedOrderId_fkey"
    FOREIGN KEY ("refusedOrderId") REFERENCES "BangladeshRefusedParcelReceipt"("orderId") ON DELETE RESTRICT ON UPDATE CASCADE;
