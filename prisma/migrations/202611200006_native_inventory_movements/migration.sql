BEGIN;

ALTER TYPE "InventoryMovementKind" ADD VALUE 'DAMAGE';

ALTER TABLE "InventoryPool"
  ADD COLUMN "lowStockThreshold" INTEGER,
  ADD CONSTRAINT "InventoryPool_lowStockThreshold_check" CHECK ("lowStockThreshold" BETWEEN 0 AND 1000000);

ALTER TABLE "InventoryMovement" ADD COLUMN "actorKind" TEXT;
ALTER TABLE "InventoryMovement" ADD COLUMN "reversesMovementId" UUID;
CREATE UNIQUE INDEX "InventoryMovement_reversesMovementId_key" ON "InventoryMovement"("reversesMovementId");

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_reversesMovementId_fkey" FOREIGN KEY ("reversesMovementId") REFERENCES "InventoryMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  DROP CONSTRAINT "InventoryMovement_direction_check",
  ADD CONSTRAINT "InventoryMovement_direction_check" CHECK (
    (kind IN ('RECEIPT', 'RETURN', 'TRANSFER_IN') AND quantity > 0)
    OR ((kind IN ('DISPATCH', 'TRANSFER_OUT') OR kind::text = 'DAMAGE') AND quantity < 0)
    OR (kind = 'ADJUSTMENT' AND quantity <> 0)
  ),
  ADD CONSTRAINT "InventoryMovement_actorKind_check" CHECK ("actorKind" IS NULL OR ("actorKind" IN ('staff', 'seller') AND "actorId" IS NOT NULL)),
  ADD CONSTRAINT "InventoryMovement_compensation_check" CHECK ("reversesMovementId" IS NULL OR (kind = 'ADJUSTMENT' AND id <> "reversesMovementId"));

CREATE TABLE "InventoryTransfer" (
  "id" UUID PRIMARY KEY,
  "fromPoolId" UUID NOT NULL REFERENCES "InventoryPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "toPoolId" UUID NOT NULL REFERENCES "InventoryPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "marketId" "MarketCode" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "dispatchKey" TEXT NOT NULL,
  "dispatchActorId" TEXT NOT NULL,
  "dispatchActorKind" TEXT NOT NULL,
  "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receiveKey" TEXT,
  "receiveActorId" TEXT,
  "receiveActorKind" TEXT,
  "receivedAt" TIMESTAMP(3),
  CONSTRAINT "InventoryTransfer_quantity_check" CHECK ("quantity" BETWEEN 1 AND 1000000 AND "fromPoolId" <> "toPoolId"),
  CONSTRAINT "InventoryTransfer_dispatchActor_check" CHECK ("dispatchActorKind" IN ('staff', 'seller')),
  CONSTRAINT "InventoryTransfer_receive_check" CHECK (
    ("receivedAt" IS NULL AND "receiveKey" IS NULL AND "receiveActorId" IS NULL AND "receiveActorKind" IS NULL)
    OR ("receivedAt" IS NOT NULL AND "receiveKey" IS NOT NULL AND "receiveActorId" IS NOT NULL
        AND "receiveActorKind" IS NOT NULL AND "receiveActorKind" IN ('staff', 'seller'))
  )
);

CREATE UNIQUE INDEX "InventoryTransfer_fromPoolId_dispatchKey_key" ON "InventoryTransfer"("fromPoolId", "dispatchKey");
CREATE INDEX "InventoryTransfer_toPoolId_receivedAt_idx" ON "InventoryTransfer"("toPoolId", "receivedAt");
CREATE INDEX "InventoryTransfer_fromPoolId_receivedAt_idx" ON "InventoryTransfer"("fromPoolId", "receivedAt");

COMMIT;
