ALTER TYPE "AuditAction" ADD VALUE 'SELLER_HUB_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'SELLER_TEAM_CHANGED';

CREATE TYPE "MarketplaceSellerPermission" AS ENUM ('PROFILE', 'LISTINGS', 'ORDER_PREPARATION', 'SUPPORT', 'FINANCE_VIEW', 'PAYOUT_REQUEST', 'PAYOUT_DESTINATION');
CREATE TYPE "SellerHubKind" AS ENUM ('NOTICE', 'REQUEST', 'CAMPAIGN', 'CONVERSATION');
CREATE TYPE "SellerHubStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DECLINED');
CREATE TYPE "SellerHubSender" AS ENUM ('STAFF', 'SELLER');

CREATE TABLE "MarketplaceSellerMember" (
  "shopId" UUID NOT NULL REFERENCES "MarketplaceShop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "shopperId" TEXT NOT NULL REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "marketId" "MarketCode" NOT NULL,
  "permissions" "MarketplaceSellerPermission"[] NOT NULL,
  "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("shopId", "shopperId", "marketId"),
  CHECK (cardinality("permissions") BETWEEN 1 AND 7)
);
CREATE INDEX "MarketplaceSellerMember_shopperId_marketId_revokedAt_idx"
  ON "MarketplaceSellerMember" ("shopperId", "marketId", "revokedAt");

CREATE TABLE "SellerHubRecord" (
  "id" UUID PRIMARY KEY,
  "kind" "SellerHubKind" NOT NULL,
  "marketId" "MarketCode",
  "shopId" UUID REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "title" VARCHAR(120) NOT NULL,
  "body" TEXT NOT NULL,
  "category" VARCHAR(16),
  "reference" VARCHAR(32),
  "status" "SellerHubStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK ("shopId" IS NULL OR "marketId" IS NOT NULL),
  CHECK ("kind" = 'NOTICE' OR ("shopId" IS NOT NULL AND "marketId" IS NOT NULL)),
  CHECK (("kind" = 'REQUEST') = ("category" IS NOT NULL)),
  CHECK ("category" IS NULL OR "category" IN ('CATEGORY', 'BRAND', 'OTHER')),
  CHECK (("kind" = 'CAMPAIGN') = ("reference" IS NOT NULL)),
  CHECK ("kind" IN ('REQUEST', 'CAMPAIGN') OR "status" = 'OPEN')
);
CREATE INDEX "SellerHubRecord_kind_marketId_updatedAt_id_idx" ON "SellerHubRecord" ("kind", "marketId", "updatedAt", "id");
CREATE INDEX "SellerHubRecord_shopId_marketId_kind_updatedAt_idx" ON "SellerHubRecord" ("shopId", "marketId", "kind", "updatedAt");
CREATE UNIQUE INDEX "SellerHubRecord_shopId_marketId_reference_key" ON "SellerHubRecord" ("shopId", "marketId", "reference");

CREATE TABLE "SellerHubPost" (
  "id" UUID PRIMARY KEY,
  "recordId" UUID NOT NULL REFERENCES "SellerHubRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "from" "SellerHubSender" NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SellerHubPost_recordId_createdAt_id_idx" ON "SellerHubPost" ("recordId", "createdAt", "id");

CREATE TABLE "SellerHubRead" (
  "recordId" UUID NOT NULL REFERENCES "SellerHubRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "shopId" UUID NOT NULL REFERENCES "MarketplaceShop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "shopperId" TEXT NOT NULL REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "marketId" "MarketCode" NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  PRIMARY KEY ("recordId", "shopId", "shopperId", "marketId")
);
CREATE INDEX "SellerHubRead_shopperId_shopId_marketId_idx" ON "SellerHubRead" ("shopperId", "shopId", "marketId");

CREATE TABLE "SellerHubOperation" (
  "actorKey" TEXT NOT NULL,
  "operationId" UUID NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "action" VARCHAR(48) NOT NULL,
  "resourceId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("actorKey", "operationId")
);
CREATE INDEX "SellerHubOperation_resourceId_createdAt_idx" ON "SellerHubOperation" ("resourceId", "createdAt");

ALTER TABLE "ShopperRequest" ADD COLUMN "marketId" "MarketCode";
