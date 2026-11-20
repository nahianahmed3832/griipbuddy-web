-- CreateEnum
CREATE TYPE "SellerFinanceEntryKind" AS ENUM ('ACCRUAL', 'HOLD', 'RELEASE', 'REFUND');

-- CreateEnum
CREATE TYPE "SellerFinanceDestinationState" AS ENUM ('PENDING', 'VERIFIED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SellerFinancePayoutState" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'RECONCILIATION', 'FAILED', 'COMPLETED');

-- CreateTable
CREATE TABLE "SellerFinancePolicy" (
    "id" UUID NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "version" INTEGER NOT NULL,
    "commissionBps" INTEGER NOT NULL,
    "processingFeeBps" INTEGER NOT NULL,
    "holdDays" INTEGER NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "actorId" TEXT NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerFinancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerFinanceEntry" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "policyId" UUID NOT NULL,
    "kind" "SellerFinanceEntryKind" NOT NULL,
    "sourceId" VARCHAR(110) NOT NULL,
    "sourceAt" TIMESTAMP(3) NOT NULL,
    "grossMinor" INTEGER NOT NULL DEFAULT 0,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "shippingMinor" INTEGER NOT NULL DEFAULT 0,
    "commissionMinor" INTEGER NOT NULL DEFAULT 0,
    "feeMinor" INTEGER NOT NULL DEFAULT 0,
    "netMinor" INTEGER NOT NULL DEFAULT 0,
    "refundMinor" INTEGER NOT NULL DEFAULT 0,
    "pendingDelta" INTEGER NOT NULL DEFAULT 0,
    "heldDelta" INTEGER NOT NULL DEFAULT 0,
    "availableDelta" INTEGER NOT NULL DEFAULT 0,
    "lineEffects" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerFinanceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerFinanceFunding" (
    "orderId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "actorId" TEXT NOT NULL,
    "testReference" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerFinanceFunding_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "SellerFinanceDestination" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "referenceHash" CHAR(64) NOT NULL,
    "maskedReference" VARCHAR(20) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "state" "SellerFinanceDestinationState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerFinanceDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerFinancePayout" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "destinationId" UUID NOT NULL,
    "destinationHash" CHAR(64) NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "status" "SellerFinancePayoutState" NOT NULL DEFAULT 'REQUESTED',
    "attemptReference" VARCHAR(64),
    "reason" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerFinancePayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerFinanceAudit" (
    "id" UUID NOT NULL,
    "shopId" UUID,
    "marketId" "MarketCode" NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "recordId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorKind" VARCHAR(12) NOT NULL,
    "action" VARCHAR(40) NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerFinanceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerFinancePolicy_marketId_currency_version_key" ON "SellerFinancePolicy"("marketId", "currency", "version");

-- CreateIndex
CREATE UNIQUE INDEX "SellerFinancePolicy_marketId_currency_effectiveAt_key" ON "SellerFinancePolicy"("marketId", "currency", "effectiveAt");

-- CreateIndex
CREATE INDEX "SellerFinanceEntry_shopId_marketId_currency_createdAt_id_idx" ON "SellerFinanceEntry"("shopId", "marketId", "currency", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SellerFinanceEntry_orderId_kind_shopId_idx" ON "SellerFinanceEntry"("orderId", "kind", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerFinanceEntry_shopId_marketId_currency_kind_sourceId_key" ON "SellerFinanceEntry"("shopId", "marketId", "currency", "kind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerFinanceFunding_operationId_key" ON "SellerFinanceFunding"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerFinanceFunding_marketId_currency_testReference_key" ON "SellerFinanceFunding"("marketId", "currency", "testReference");

-- CreateIndex
CREATE INDEX "SellerFinanceDestination_shopId_marketId_currency_state_idx" ON "SellerFinanceDestination"("shopId", "marketId", "currency", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SellerFinanceDestination_id_shopId_marketId_currency_key" ON "SellerFinanceDestination"("id", "shopId", "marketId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "SellerFinancePayout_attemptReference_key" ON "SellerFinancePayout"("attemptReference");

-- CreateIndex
CREATE INDEX "SellerFinancePayout_shopId_marketId_currency_status_idx" ON "SellerFinancePayout"("shopId", "marketId", "currency", "status");

-- CreateIndex
CREATE INDEX "SellerFinancePayout_marketId_currency_status_updatedAt_idx" ON "SellerFinancePayout"("marketId", "currency", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "SellerFinanceAudit_marketId_currency_recordId_createdAt_idx" ON "SellerFinanceAudit"("marketId", "currency", "recordId", "createdAt");

-- AddForeignKey
ALTER TABLE "SellerFinanceEntry" ADD CONSTRAINT "SellerFinanceEntry_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerFinanceEntry" ADD CONSTRAINT "SellerFinanceEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerFinanceEntry" ADD CONSTRAINT "SellerFinanceEntry_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "SellerFinancePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerFinanceFunding" ADD CONSTRAINT "SellerFinanceFunding_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerFinanceDestination" ADD CONSTRAINT "SellerFinanceDestination_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerFinancePayout" ADD CONSTRAINT "SellerFinancePayout_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerFinancePayout" ADD CONSTRAINT "SellerFinancePayout_destinationId_shopId_marketId_currency_fkey" FOREIGN KEY ("destinationId", "shopId", "marketId", "currency") REFERENCES "SellerFinanceDestination"("id", "shopId", "marketId", "currency") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "SellerFinancePolicy" ADD CONSTRAINT "SellerFinancePolicy_synthetic_terms"
  CHECK ("version" > 0 AND "commissionBps" BETWEEN 0 AND 10000 AND "processingFeeBps" BETWEEN 0 AND 10000
    AND "commissionBps" + "processingFeeBps" <= 10000 AND "holdDays" BETWEEN 0 AND 180);
ALTER TABLE "SellerFinanceEntry" ADD CONSTRAINT "SellerFinanceEntry_fund_reconciliation"
  CHECK ("netMinor"::bigint = "pendingDelta"::bigint + "heldDelta"::bigint + "availableDelta"::bigint);
ALTER TABLE "SellerFinancePayout" ADD CONSTRAINT "SellerFinancePayout_positive_amount"
  CHECK ("amountMinor" > 0);
