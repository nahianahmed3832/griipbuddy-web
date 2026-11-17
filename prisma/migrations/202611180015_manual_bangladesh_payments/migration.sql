ALTER TYPE "PaymentMethod" ADD VALUE 'BKASH';
ALTER TYPE "PaymentMethod" ADD VALUE 'NAGAD';
ALTER TYPE "PaymentMethod" ADD VALUE 'ROCKET';
ALTER TYPE "PaymentStatus" ADD VALUE 'AWAITING_VERIFICATION';

CREATE TABLE "BangladeshManualProof" (
    "orderId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "recipient" TEXT NOT NULL,
    "test" BOOLEAN NOT NULL,
    "payerPhone" TEXT,
    "submittedTransaction" TEXT,
    "receipt" BYTEA,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "verifiedTransaction" TEXT,
    CONSTRAINT "BangladeshManualProof_pkey" PRIMARY KEY ("orderId"),
    CONSTRAINT "BangladeshManualProof_evidence" CHECK (
      ("receipt" IS NOT NULL AND "payerPhone" IS NULL AND "submittedTransaction" IS NULL) OR
      ("receipt" IS NULL AND "payerPhone" IS NOT NULL AND "submittedTransaction" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "BangladeshManualProof_method_test_verifiedTransaction_key"
    ON "BangladeshManualProof"("method", "test", "verifiedTransaction");

ALTER TABLE "BangladeshManualProof" ADD CONSTRAINT "BangladeshManualProof_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Payment"("orderId") ON DELETE RESTRICT ON UPDATE CASCADE;
