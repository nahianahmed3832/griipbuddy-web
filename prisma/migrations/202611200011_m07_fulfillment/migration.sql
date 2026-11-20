CREATE TYPE "ParcelPreparationState" AS ENUM ('PENDING', 'PICKED', 'PACKED');

ALTER TABLE "OrderParcel"
  ADD COLUMN "preparationState" "ParcelPreparationState",
  ADD COLUMN "dispatchOperationId" UUID,
  ADD COLUMN "dispatchRequestHash" CHAR(64);

CREATE TABLE "OrderParcelPreparationEvent" (
  "parcelId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "state" "ParcelPreparationState" NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "actorId" TEXT NOT NULL,
  "items" JSONB NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderParcelPreparationEvent_pkey" PRIMARY KEY ("parcelId", "operationId"),
  CONSTRAINT "OrderParcelPreparationEvent_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "OrderParcel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "OrderParcelPreparationEvent_parcelId_recordedAt_idx" ON "OrderParcelPreparationEvent"("parcelId", "recordedAt");
