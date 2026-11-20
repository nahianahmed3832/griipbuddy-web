BEGIN;

-- CreateEnum
CREATE TYPE "InventoryReservationState" AS ENUM ('HELD', 'COMMITTED', 'RELEASED', 'EXPIRED', 'CANCELLED', 'PAYMENT_EXCEPTION');

-- CreateEnum
CREATE TYPE "InventoryMovementKind" AS ENUM ('RECEIPT', 'DISPATCH', 'RETURN', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "managedInventory" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MarketOffer" ADD COLUMN     "offerId" UUID,
ADD COLUMN     "publication" "PublicationState" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StaffMarketAccess" ADD COLUMN     "commercial" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MarketOfferIdentity" (
    "id" UUID NOT NULL,
    "variantId" TEXT NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "sellerId" UUID NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "retiredTerms" JSONB,

    CONSTRAINT "MarketOfferIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchLocationMarket" (
    "locationId" TEXT NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "districts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "methods" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "DispatchLocationMarket_pkey" PRIMARY KEY ("locationId","marketId")
);

-- CreateTable
CREATE TABLE "InventoryPool" (
    "id" UUID NOT NULL,
    "variantId" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReservation" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "state" "InventoryReservationState" NOT NULL DEFAULT 'HELD',
    "requestHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "orderId" UUID,
    "paymentReference" TEXT,
    "paymentAmountMinor" INTEGER,
    "paymentCurrency" "CurrencyCode",
    "exceptionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAllocation" (
    "id" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" "CurrencyCode" NOT NULL,
    "offerRevision" INTEGER NOT NULL,
    "dispatched" INTEGER NOT NULL DEFAULT 0,
    "returned" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InventoryAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "relatedPoolId" UUID,
    "allocationId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "kind" "InventoryMovementKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketOfferIdentity_variantId_marketId_idx" ON "MarketOfferIdentity"("variantId", "marketId");

-- CreateIndex
CREATE INDEX "MarketOfferIdentity_sellerId_marketId_idx" ON "MarketOfferIdentity"("sellerId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOfferIdentity_id_variantId_marketId_key" ON "MarketOfferIdentity"("id", "variantId", "marketId");

-- CreateIndex
CREATE INDEX "DispatchLocationMarket_marketId_active_priority_idx" ON "DispatchLocationMarket"("marketId", "active", "priority");

-- CreateIndex
CREATE INDEX "InventoryPool_ownerId_locationId_idx" ON "InventoryPool"("ownerId", "locationId");

-- CreateIndex
CREATE INDEX "InventoryPool_locationId_idx" ON "InventoryPool"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPool_variantId_ownerId_locationId_key" ON "InventoryPool"("variantId", "ownerId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReservation_attemptId_key" ON "InventoryReservation"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReservation_orderId_key" ON "InventoryReservation"("orderId");

-- CreateIndex
CREATE INDEX "InventoryReservation_state_expiresAt_idx" ON "InventoryReservation"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "InventoryReservation_marketId_state_idx" ON "InventoryReservation"("marketId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReservation_paymentMethod_paymentReference_key" ON "InventoryReservation"("paymentMethod", "paymentReference");

-- CreateIndex
CREATE INDEX "InventoryAllocation_offerId_idx" ON "InventoryAllocation"("offerId");

-- CreateIndex
CREATE INDEX "InventoryAllocation_poolId_idx" ON "InventoryAllocation"("poolId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryAllocation_reservationId_offerId_poolId_key" ON "InventoryAllocation"("reservationId", "offerId", "poolId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryAllocation_id_poolId_key" ON "InventoryAllocation"("id", "poolId");

-- CreateIndex
CREATE INDEX "InventoryMovement_poolId_createdAt_idx" ON "InventoryMovement"("poolId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_allocationId_idx" ON "InventoryMovement"("allocationId");

-- CreateIndex
CREATE INDEX "InventoryMovement_relatedPoolId_idx" ON "InventoryMovement"("relatedPoolId");

-- CreateIndex
CREATE INDEX "InventoryMovement_kind_reference_idx" ON "InventoryMovement"("kind", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_poolId_idempotencyKey_key" ON "InventoryMovement"("poolId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOffer_offerId_key" ON "MarketOffer"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketOffer_offerId_variantId_marketId_key" ON "MarketOffer"("offerId", "variantId", "marketId");

-- AddForeignKey
ALTER TABLE "MarketOffer" ADD CONSTRAINT "MarketOffer_offerId_variantId_marketId_fkey" FOREIGN KEY ("offerId", "variantId", "marketId") REFERENCES "MarketOfferIdentity"("id", "variantId", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOfferIdentity" ADD CONSTRAINT "MarketOfferIdentity_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketOfferIdentity" ADD CONSTRAINT "MarketOfferIdentity_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchLocationMarket" ADD CONSTRAINT "DispatchLocationMarket_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "DispatchLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPool" ADD CONSTRAINT "InventoryPool_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPool" ADD CONSTRAINT "InventoryPool_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPool" ADD CONSTRAINT "InventoryPool_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "DispatchLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "CheckoutAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAllocation" ADD CONSTRAINT "InventoryAllocation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "InventoryReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAllocation" ADD CONSTRAINT "InventoryAllocation_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "MarketOfferIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAllocation" ADD CONSTRAINT "InventoryAllocation_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "InventoryPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "InventoryPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_relatedPoolId_fkey" FOREIGN KEY ("relatedPoolId") REFERENCES "InventoryPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_allocationId_poolId_fkey" FOREIGN KEY ("allocationId", "poolId") REFERENCES "InventoryAllocation"("id", "poolId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy current offers keep their compound key, prices and null connected identity.
ALTER TABLE "MarketOffer" ADD CONSTRAINT "MarketOffer_connected_terms_check" CHECK (
  "offerId" IS NULL OR (
    "amountMinor" > 0 AND revision >= 0 AND (
      ("discountMinor" IS NULL AND "discountStartsAt" IS NULL AND "discountEndsAt" IS NULL) OR
      ("discountMinor" IS NOT NULL AND "discountMinor" > 0 AND "discountMinor" < "amountMinor"
        AND "discountStartsAt" IS NOT NULL AND "discountEndsAt" IS NOT NULL AND "discountStartsAt" < "discountEndsAt")
    )
  )
);

CREATE UNIQUE INDEX "MarketOfferIdentity_one_current_per_variant_market"
  ON "MarketOfferIdentity" ("variantId", "marketId") WHERE "retiredAt" IS NULL;

ALTER TABLE "MarketOfferIdentity" ADD CONSTRAINT "MarketOfferIdentity_retirement_check"
  CHECK (("retiredAt" IS NULL) = ("retiredTerms" IS NULL));

ALTER TABLE "Variant" ADD CONSTRAINT "Variant_managed_inventory_check"
  CHECK (NOT "managedInventory" OR "optionSignature" IS NOT NULL);

ALTER TABLE "DispatchLocationMarket"
  ALTER COLUMN districts SET NOT NULL, ALTER COLUMN methods SET NOT NULL,
  ADD CONSTRAINT "DispatchLocationMarket_named_check" CHECK ("locationId" <> 'legacy-primary'),
  ADD CONSTRAINT "DispatchLocationMarket_priority_check" CHECK (priority >= 0);

ALTER TABLE "InventoryPool"
  ADD CONSTRAINT "InventoryPool_named_check" CHECK ("locationId" <> 'legacy-primary'),
  ADD CONSTRAINT "InventoryPool_quantity_check" CHECK (reserved >= 0 AND "onHand" >= reserved);

ALTER TABLE "InventoryReservation"
  ADD CONSTRAINT "InventoryReservation_order_state_check" CHECK (("orderId" IS NOT NULL) = (state IN ('COMMITTED', 'CANCELLED'))),
  ADD CONSTRAINT "InventoryReservation_payment_check" CHECK (
    num_nonnulls("paymentReference", "paymentAmountMinor", "paymentCurrency") IN (0, 3)
    AND ("paymentAmountMinor" IS NULL OR "paymentAmountMinor" > 0)
  ),
  ADD CONSTRAINT "InventoryReservation_exception_check" CHECK (
    state <> 'PAYMENT_EXCEPTION' OR ("paymentReference" IS NOT NULL AND "exceptionReason" IS NOT NULL)
  );

ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_quantity_check"
    CHECK (quantity > 0 AND dispatched >= 0 AND dispatched <= quantity AND returned >= 0 AND returned <= dispatched),
  ADD CONSTRAINT "InventoryAllocation_offer_terms_check" CHECK ("amountMinor" > 0 AND "offerRevision" >= 0);

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_direction_check" CHECK (
    (kind IN ('RECEIPT', 'RETURN', 'TRANSFER_IN') AND quantity > 0)
    OR (kind IN ('DISPATCH', 'TRANSFER_OUT') AND quantity < 0)
    OR (kind = 'ADJUSTMENT' AND quantity <> 0)
  ),
  ADD CONSTRAINT "InventoryMovement_allocation_check"
    CHECK (("allocationId" IS NOT NULL) = (kind IN ('DISPATCH', 'RETURN'))),
  ADD CONSTRAINT "InventoryMovement_transfer_check" CHECK (
    ("relatedPoolId" IS NOT NULL) = (kind IN ('TRANSFER_IN', 'TRANSFER_OUT')) AND "relatedPoolId" IS DISTINCT FROM "poolId"
  );

COMMIT;
