ALTER TABLE "Product" ADD COLUMN "videoUrl" TEXT;
ALTER TABLE "Variant" ADD COLUMN "videoUrl" TEXT;
ALTER TABLE "CatalogMedia" ADD COLUMN "contentType" TEXT NOT NULL DEFAULT 'image/webp';

CREATE INDEX "Product_videoUrl_idx" ON "Product"("videoUrl");
CREATE INDEX "Variant_videoUrl_idx" ON "Variant"("videoUrl");
