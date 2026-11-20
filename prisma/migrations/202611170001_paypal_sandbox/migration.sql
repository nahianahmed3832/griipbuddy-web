ALTER TYPE "PaymentMethod" ADD VALUE 'PAYPAL';
ALTER TYPE "PaymentStatus" ADD VALUE 'PAID';
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUND_PENDING';
ALTER TYPE "PaymentStatus" ADD VALUE 'REFUNDED';

CREATE TYPE "PayPalCheckoutState" AS ENUM ('CREATING', 'APPROVAL', 'CAPTURING', 'COMPLETED', 'CANCELLED');
CREATE TABLE "PayPalCheckout" (
    "attemptId" UUID NOT NULL,
    "state" "PayPalCheckoutState" NOT NULL DEFAULT 'CREATING',
    "checkout" JSONB,
    "quote" JSONB,
    "shopperId" TEXT,
    "providerOrderId" TEXT,
    "approvalUrl" TEXT,
    "captureId" TEXT,
    "captureStartedAt" TIMESTAMP(3),
    "refundId" TEXT,
    "refundStartedAt" TIMESTAMP(3),
    "refundActorId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayPalCheckout_pkey" PRIMARY KEY ("attemptId"),
    CONSTRAINT "PayPalCheckout_attemptId_fkey" FOREIGN KEY ("attemptId")
      REFERENCES "CheckoutAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PayPalCheckout_providerOrderId_key" ON "PayPalCheckout"("providerOrderId");
CREATE UNIQUE INDEX "PayPalCheckout_captureId_key" ON "PayPalCheckout"("captureId");
CREATE UNIQUE INDEX "PayPalCheckout_refundId_key" ON "PayPalCheckout"("refundId");
CREATE INDEX "PayPalCheckout_state_expiresAt_idx" ON "PayPalCheckout"("state", "expiresAt");
