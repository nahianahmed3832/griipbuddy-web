BEGIN;

CREATE TYPE "CodRemittanceStatus" AS ENUM ('DISCREPANCY', 'MATCHED');

CREATE TABLE "CodRemittance" (
  "orderId" UUID NOT NULL REFERENCES "Order"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "attempt" INTEGER NOT NULL,
  "status" "CodRemittanceStatus" NOT NULL,
  "reference" VARCHAR(80) NOT NULL,
  "expectedGrossMinor" INTEGER NOT NULL,
  "grossMinor" INTEGER NOT NULL,
  "deductionsMinor" INTEGER NOT NULL,
  "netMinor" INTEGER NOT NULL,
  "actorId" TEXT REFERENCES "user"("id") ON UPDATE CASCADE ON DELETE SET NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodRemittance_pkey" PRIMARY KEY ("orderId", "attempt"),
  CONSTRAINT "CodRemittance_amounts_check" CHECK (
    "attempt" > 0 AND char_length(btrim("reference")) > 0
    AND "expectedGrossMinor" >= 0 AND "grossMinor" >= 0 AND "deductionsMinor" >= 0 AND "netMinor" >= 0
  ),
  CONSTRAINT "CodRemittance_match_check" CHECK (
    ("status" = 'MATCHED') = ("grossMinor" = "expectedGrossMinor" AND "netMinor" = "grossMinor" - "deductionsMinor")
  )
);

CREATE INDEX "CodRemittance_status_orderId_idx" ON "CodRemittance"("status", "orderId");
CREATE UNIQUE INDEX "CodRemittance_orderId_matched_key" ON "CodRemittance"("orderId") WHERE "status" = 'MATCHED';

COMMIT;
