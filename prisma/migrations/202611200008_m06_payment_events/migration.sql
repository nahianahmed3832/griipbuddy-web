ALTER TABLE "PayPalCheckout" ADD COLUMN "providerAccountKey" VARCHAR(64), ADD COLUMN "expectedAmountMinor" INTEGER;
ALTER TABLE "PrepaidCheckout" ADD COLUMN "providerAccountKey" VARCHAR(64), ADD COLUMN "expectedAmountMinor" INTEGER;

CREATE TABLE "ProviderPaymentEvent" (
    "provider" "PaymentMethod" NOT NULL,
    "accountKey" VARCHAR(64) NOT NULL,
    "eventKey" VARCHAR(160) NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "attemptId" UUID,
    "eventType" VARCHAR(60) NOT NULL,
    "evidenceHash" VARCHAR(64) NOT NULL,
    "providerReference" VARCHAR(80) NOT NULL,
    "amountMinor" INTEGER,
    "currency" "CurrencyCode",
    "outcome" VARCHAR(32),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderPaymentEvent_pkey" PRIMARY KEY ("provider", "accountKey", "eventKey"),
    CONSTRAINT "ProviderPaymentEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "CheckoutAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "ProviderPaymentEvent_attemptId_receivedAt_idx" ON "ProviderPaymentEvent"("attemptId", "receivedAt");
