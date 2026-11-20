ALTER TABLE "OrderItem"
  ADD COLUMN "productIdSnapshot" TEXT,
  ADD COLUMN "offerIdSnapshot" UUID,
  ADD COLUMN "cartOfferIdSnapshot" UUID,
  ADD COLUMN "cartVariantIdSnapshot" TEXT,
  ADD COLUMN "optionsSnapshot" JSONB,
  ADD COLUMN "imageSrcSnapshot" TEXT,
  ADD COLUMN "imageAltSnapshot" TEXT,
  ADD COLUMN "marketplaceShopNameSnapshot" TEXT;

ALTER TYPE "MeasurementKind" ADD VALUE 'VARIANT_SELECTION';
