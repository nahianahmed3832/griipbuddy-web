CREATE TYPE "SellerListingReviewState" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'PUBLISHED', 'REJECTED', 'WITHDRAWN');

CREATE TABLE "SellerListingReview" (
    "productId" TEXT NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "baseProductRevision" INTEGER NOT NULL,
    "creationRequestHash" CHAR(64),
    "state" "SellerListingReviewState" NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL,
    "feedback" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SellerListingReview_pkey" PRIMARY KEY ("productId", "marketId"),
    CONSTRAINT "SellerListingReview_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SellerListingReview_marketId_state_updatedAt_idx" ON "SellerListingReview"("marketId", "state", "updatedAt");

CREATE TABLE "SellerListingAsset" (
    "shopId" UUID NOT NULL,
    "mediaId" CHAR(64) NOT NULL,
    CONSTRAINT "SellerListingAsset_pkey" PRIMARY KEY ("shopId", "mediaId"),
    CONSTRAINT "SellerListingAsset_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SellerListingAsset_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "CatalogMedia"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SellerListingAsset_mediaId_shopId_idx" ON "SellerListingAsset"("mediaId", "shopId");
