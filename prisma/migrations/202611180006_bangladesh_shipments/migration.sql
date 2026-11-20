CREATE TYPE "BangladeshShipmentStatus" AS ENUM ('IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REFUSED');
CREATE TYPE "BangladeshShipmentSource" AS ENUM ('MANUAL', 'DEV_SIMULATOR');

CREATE TABLE "BangladeshShipment" (
    "orderId" UUID NOT NULL,
    "carrier" VARCHAR(60) NOT NULL,
    "trackingReference" VARCHAR(80) NOT NULL,
    "status" "BangladeshShipmentStatus" NOT NULL,
    "source" "BangladeshShipmentSource" NOT NULL,
    "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BangladeshShipment_pkey" PRIMARY KEY ("orderId"),
    CONSTRAINT "BangladeshShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BangladeshShipmentEvent" (
    "orderId" UUID NOT NULL,
    "status" "BangladeshShipmentStatus" NOT NULL,
    "actorId" TEXT NOT NULL,
    "evidence" VARCHAR(200),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BangladeshShipmentEvent_pkey" PRIMARY KEY ("orderId", "status"),
    CONSTRAINT "BangladeshShipmentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "BangladeshShipment"("orderId") ON DELETE RESTRICT ON UPDATE CASCADE
);
