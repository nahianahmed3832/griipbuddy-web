CREATE TYPE "ParcelTrackingStatus" AS ENUM ('PREPARING', 'HANDED_TO_CARRIER', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_EXCEPTION', 'RETURNED');
CREATE TYPE "ParcelTrackingSource" AS ENUM ('MANUAL', 'CARRIER_WEBHOOK');
CREATE TYPE "ParcelTrackingSyncError" AS ENUM ('UNAVAILABLE', 'NOT_FOUND', 'RATE_LIMITED');

ALTER TABLE "OrderParcel" ADD COLUMN "splitRequestHash" CHAR(64),
ADD COLUMN "trackingStatus" "ParcelTrackingStatus", ADD COLUMN "trackingOccurredAt" TIMESTAMP(3),
ADD COLUMN "trackingReportedAt" TIMESTAMP(3), ADD COLUMN "trackingSyncedAt" TIMESTAMP(3),
ADD COLUMN "trackingAttemptAt" TIMESTAMP(3), ADD COLUMN "trackingSyncError" "ParcelTrackingSyncError",
ADD COLUMN "trackingRevision" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "estimatedDeliveryAt" TIMESTAMP(3);

DROP INDEX "OrderParcel_orderId_locationId_key";
CREATE INDEX "OrderParcel_orderId_locationId_idx" ON "OrderParcel"("orderId", "locationId");
ALTER TABLE "OrderParcel" DROP CONSTRAINT "OrderParcel_tracking_check";
ALTER TABLE "OrderParcel" ADD CONSTRAINT "OrderParcel_tracking_check" CHECK (
  ("status" = 'PLANNED' AND "source" IS NULL AND ("carrier" IS NULL) = ("trackingReference" IS NULL))
  OR ("status" <> 'PLANNED' AND "carrier" IS NOT NULL AND "trackingReference" IS NOT NULL AND "source" IS NOT NULL)
);
ALTER TABLE "OrderParcelEvent" ADD COLUMN "reason" VARCHAR(200);

CREATE TABLE "ParcelTrackingObservation" (
  "id" UUID NOT NULL,
  "parcelId" UUID NOT NULL,
  "source" "ParcelTrackingSource" NOT NULL,
  "status" "ParcelTrackingStatus",
  "eventKey" VARCHAR(140),
  "providerCode" VARCHAR(50),
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estimatedDeliveryAt" TIMESTAMP(3),
  "error" "ParcelTrackingSyncError",
  "actorId" TEXT,
  "reason" VARCHAR(200),
  "applied" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "ParcelTrackingObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ParcelTrackingObservation_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "OrderParcel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ParcelTrackingObservation_provenance_check" CHECK (
    ("source" = 'MANUAL' AND "actorId" IS NOT NULL AND "reason" IS NOT NULL AND "eventKey" IS NULL AND "error" IS NULL)
    OR ("source" = 'CARRIER_WEBHOOK' AND "actorId" IS NULL AND "reason" IS NULL AND "eventKey" IS NOT NULL
      AND (("status" IS NOT NULL AND "error" IS NULL) OR ("status" IS NULL AND "error" IS NOT NULL AND "estimatedDeliveryAt" IS NULL)))
  )
);

CREATE UNIQUE INDEX "ParcelTrackingObservation_parcelId_eventKey_key" ON "ParcelTrackingObservation"("parcelId", "eventKey");
CREATE INDEX "ParcelTrackingObservation_parcelId_occurredAt_id_idx" ON "ParcelTrackingObservation"("parcelId", "occurredAt", "id");
