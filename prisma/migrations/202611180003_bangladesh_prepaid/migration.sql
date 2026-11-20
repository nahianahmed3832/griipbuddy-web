ALTER TYPE "PaymentMethod" ADD VALUE 'SSLCOMMERZ';
ALTER TABLE "Order" ADD COLUMN "prepaidDiscountMinor" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrderItem" ADD COLUMN "prepaidDiscountMinor" INTEGER NOT NULL DEFAULT 0;

CREATE TYPE "PrepaidCheckoutState" AS ENUM ('PREPARING', 'AWAITING_PAYMENT', 'PAID', 'CLOSED');

CREATE TABLE "PrepaidCheckout" (
    "attemptId" UUID NOT NULL REFERENCES "CheckoutAttempt" ("id") ON DELETE CASCADE,
    "providerId" VARCHAR(30) NOT NULL,
    "state" "PrepaidCheckoutState" NOT NULL DEFAULT 'PREPARING',
    "checkout" JSONB,
    "quote" JSONB,
    "marketplaceShopIds" JSONB,
    "shopperId" TEXT,
    "direct" BOOLEAN NOT NULL DEFAULT false,
    "couponCode" VARCHAR(32),
    "redirectUrl" TEXT,
    "bankTransactionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrepaidCheckout_pkey" PRIMARY KEY ("attemptId")
);

CREATE UNIQUE INDEX "PrepaidCheckout_providerId_key" ON "PrepaidCheckout" ("providerId");
CREATE UNIQUE INDEX "PrepaidCheckout_bankTransactionId_key" ON "PrepaidCheckout" ("bankTransactionId");
CREATE INDEX "PrepaidCheckout_state_expiresAt_idx" ON "PrepaidCheckout" ("state", "expiresAt");
CREATE INDEX "PrepaidCheckout_couponCode_state_idx" ON "PrepaidCheckout" ("couponCode", "state");
