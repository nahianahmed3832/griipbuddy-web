CREATE TYPE "CommerceEvidence" AS ENUM ('fixture', 'sandbox', 'production');

ALTER TABLE "CheckoutAttempt"
  ADD COLUMN "marketId" "MarketCode",
  ADD COLUMN "paymentMethod" "PaymentMethod",
  ADD COLUMN "commerceEvidence" "CommerceEvidence",
  ADD COLUMN "commercialSnapshot" JSONB;

ALTER TABLE "Order"
  ADD COLUMN "commerceEvidence" "CommerceEvidence",
  ADD COLUMN "commercialSnapshot" JSONB;

UPDATE "CheckoutAttempt" a
SET "marketId" = o."marketId", "paymentMethod" = p."method"
FROM "Order" o LEFT JOIN "Payment" p ON p."orderId" = o."id"
WHERE a."id" = o."attemptId";

-- Before this migration these provider handlers could create only these markets.
UPDATE "CheckoutAttempt" a SET "marketId" = 'us', "paymentMethod" = 'PAYPAL'
FROM "PayPalCheckout" p WHERE a."id" = p."attemptId" AND a."marketId" IS NULL;
UPDATE "CheckoutAttempt" a SET "marketId" = 'bd', "paymentMethod" = 'SSLCOMMERZ'
FROM "PrepaidCheckout" p WHERE a."id" = p."attemptId" AND a."marketId" IS NULL;
UPDATE "CheckoutAttempt" SET "marketId" = 'bd', "paymentMethod" = 'COD'
WHERE "recoveredCart" IS NOT NULL AND "marketId" IS NULL;

UPDATE "Order" SET "commerceEvidence" = 'production' WHERE "measurementTest" = FALSE;
UPDATE "CheckoutAttempt" a SET "commerceEvidence" = o."commerceEvidence"
FROM "Order" o WHERE a."id" = o."attemptId" AND o."commerceEvidence" IS NOT NULL;

CREATE INDEX "CheckoutAttempt_marketId_commerceEvidence_idx"
ON "CheckoutAttempt" ("marketId", "commerceEvidence");
