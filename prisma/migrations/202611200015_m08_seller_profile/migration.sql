CREATE TABLE "SellerMarketProfile" (
  "shopId" UUID NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "presentation" VARCHAR(16) NOT NULL CHECK ("presentation" IN ('classic', 'compact')),
  "about" VARCHAR(1600) NOT NULL,
  "announcement" VARCHAR(200) NOT NULL,
  "locale" VARCHAR(35) NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  PRIMARY KEY ("shopId", "marketId"),
  FOREIGN KEY ("shopId", "marketId") REFERENCES "MarketplaceShopMarket"("shopId", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "SellerBusinessAddress" (
  "id" UUID PRIMARY KEY,
  "shopId" UUID NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "purpose" VARCHAR(16) NOT NULL CHECK ("purpose" IN ('business', 'returns')),
  "line" VARCHAR(180) NOT NULL,
  "city" VARCHAR(90) NOT NULL,
  "region" VARCHAR(90) NOT NULL,
  "postal" VARCHAR(20) NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "archived" BOOLEAN NOT NULL DEFAULT false,
  FOREIGN KEY ("shopId", "marketId") REFERENCES "MarketplaceShopMarket"("shopId", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SellerBusinessAddress_scope_idx" ON "SellerBusinessAddress"("shopId", "marketId", "archived");

CREATE TABLE "SellerVerificationForm" (
  "marketId" "MarketCode" NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "fields" JSONB NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("marketId", "version")
);

CREATE TABLE "SellerVerificationSubmission" (
  "id" UUID PRIMARY KEY,
  "shopId" UUID NOT NULL,
  "marketId" "MarketCode" NOT NULL,
  "version" INTEGER NOT NULL,
  "answers" JSONB NOT NULL,
  "state" VARCHAR(16) NOT NULL CHECK ("state" IN ('SUBMITTED', 'ACCEPTED', 'DECLINED')),
  "note" VARCHAR(400),
  "actorId" TEXT NOT NULL,
  "reviewedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  FOREIGN KEY ("shopId", "marketId") REFERENCES "MarketplaceShopMarket"("shopId", "marketId") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("marketId", "version") REFERENCES "SellerVerificationForm"("marketId", "version") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (("state" = 'SUBMITTED') = ("reviewedAt" IS NULL AND "reviewedBy" IS NULL))
);
CREATE INDEX "SellerVerificationSubmission_queue_idx" ON "SellerVerificationSubmission"("marketId", "state", "createdAt");
CREATE INDEX "SellerVerificationSubmission_org_idx" ON "SellerVerificationSubmission"("shopId", "marketId", "createdAt");
CREATE UNIQUE INDEX "SellerVerificationSubmission_open_idx" ON "SellerVerificationSubmission"("shopId", "marketId")
  WHERE "state" = 'SUBMITTED';

CREATE TABLE "SellerProfileAudit" (
  "id" UUID PRIMARY KEY,
  "shopId" UUID,
  "marketId" "MarketCode" NOT NULL,
  "target" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorKind" VARCHAR(16) NOT NULL CHECK ("actorKind" IN ('seller', 'staff')),
  "action" VARCHAR(32) NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SellerProfileAudit_scope_idx" ON "SellerProfileAudit"("shopId", "marketId", "createdAt");
