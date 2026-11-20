ALTER TYPE "AuditAction" ADD VALUE 'MERCHANDISING_REVIEW';
ALTER TABLE "Product" ADD COLUMN "shortDescription" TEXT;
CREATE INDEX "ProductImage_src_idx" ON "ProductImage"("src");
CREATE INDEX "Variant_imageSrc_idx" ON "Variant"("imageSrc");

CREATE TABLE "MerchandisingCandidate" (
    "id" CHAR(64) PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "sourceVersion" CHAR(64) NOT NULL,
    "draft" JSONB NOT NULL,
    "baseline" JSONB,
    "baseRevision" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "decision" TEXT NOT NULL DEFAULT 'pending' CHECK ("decision" IN ('pending', 'approved', 'rejected')),
    "approval" JSONB,
    "ownsDraft" BOOLEAN NOT NULL DEFAULT false,
    "catalogRevision" INTEGER,
    "stagedRevision" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "launch" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "MerchandisingCandidate_updatedAt_idx" ON "MerchandisingCandidate"("updatedAt");
CREATE INDEX "MerchandisingCandidate_productId_ownsDraft_idx" ON "MerchandisingCandidate"("productId", "ownsDraft");
