BEGIN;

CREATE TYPE "PublicationState" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
ALTER TYPE "AuditAction" ADD VALUE 'STAFF_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'PRODUCT_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'TAXONOMY_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'MARKET_SETTINGS_CHANGED';

ALTER TABLE "Product"
    ADD COLUMN "publication" "PublicationState" NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN "demo" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
UPDATE "Product" SET "publication" = 'ACTIVE' WHERE "active";
UPDATE "Product" SET "demo" = true WHERE "id" IN (
    'p-tote', 'p-tee', 'p-sneakers', 'p-beanie', 'p-mug', 'p-cushion', 'p-glass', 'p-lamp',
    'p-headphones', 'p-speaker', 'p-cable', 'p-stand', 'p-refill', 'p-stone', 'p-bands', 'p-brush',
    'p-bottle', 'p-mat', 'p-rope', 'p-pack', 'p-notebooks', 'p-bento', 'p-umbrella', 'p-carry-set'
);
CREATE INDEX "Product_publication_position_idx" ON "Product" ("publication", "position");

CREATE TABLE "CatalogMedia" (
    "id" CHAR(64) PRIMARY KEY,
    "data" BYTEA NOT NULL CHECK (octet_length("data") BETWEEN 1 AND 4194304),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "CheckoutPolicy" ADD COLUMN "countryCode" CHAR(2), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
UPDATE "CheckoutPolicy" SET "countryCode" = upper("marketId"::text);
ALTER TABLE "CheckoutPolicy"
    ALTER COLUMN "countryCode" SET NOT NULL,
    ALTER COLUMN "taxTreatment" DROP NOT NULL,
    ALTER COLUMN "taxBasisPoints" DROP NOT NULL,
    ALTER COLUMN "taxLabel" DROP NOT NULL,
    ADD CONSTRAINT "CheckoutPolicy_country_check" CHECK (
        "countryCode" = upper("marketId"::text)
        AND (("marketId" = 'bd' AND "currency" = 'BDT') OR ("marketId" = 'us' AND "currency" = 'USD'))
    );
ALTER TABLE "DeliveryZone"
    ALTER COLUMN "chargeMinor" DROP NOT NULL,
    ADD COLUMN "guidance" TEXT,
    ADD COLUMN "codEligible" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "deliveryGuidance" TEXT;

CREATE TABLE "RequestQuota" (
    "key" CHAR(64) PRIMARY KEY,
    "resetsAt" TIMESTAMP(3) NOT NULL,
    "hits" INTEGER NOT NULL
);
CREATE INDEX "RequestQuota_resetsAt_idx" ON "RequestQuota" ("resetsAt");

COMMIT;
