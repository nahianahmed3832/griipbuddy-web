ALTER TABLE "CheckoutAttempt"
  ADD COLUMN "quoteExpiresAt" TIMESTAMP(3),
  ADD COLUMN "reviewActor" TEXT;

ALTER TABLE "OrderItem"
  ADD COLUMN "pricedOfferRevision" INTEGER,
  ADD COLUMN "deliveryAllocatedMinor" INTEGER,
  ADD COLUMN "taxAllocatedMinor" INTEGER,
  ADD CONSTRAINT "OrderItem_checkout_snapshot_nonnegative" CHECK (
    "pricedOfferRevision" >= 0 AND "deliveryAllocatedMinor" >= 0 AND "taxAllocatedMinor" >= 0
  );
