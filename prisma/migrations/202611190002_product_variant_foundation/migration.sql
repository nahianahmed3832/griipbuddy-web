BEGIN;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "attributeValues" JSONB,
ADD COLUMN     "foundation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "attributeValues" JSONB,
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "optionSignature" TEXT;

-- CreateTable
CREATE TABLE "ProductTranslation" (
    "productId" TEXT NOT NULL,
    "locale" VARCHAR(35) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "shortDescription" TEXT,

    CONSTRAINT "ProductTranslation_pkey" PRIMARY KEY ("productId","locale")
);

-- CreateTable
CREATE TABLE "ProductOption" (
    "productId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProductOption_pkey" PRIMARY KEY ("productId","id")
);

-- CreateTable
CREATE TABLE "ProductOptionValue" (
    "productId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ProductOptionValue_pkey" PRIMARY KEY ("productId","optionId","id")
);

-- CreateTable
CREATE TABLE "VariantOptionSelection" (
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "optionValueId" TEXT NOT NULL,

    CONSTRAINT "VariantOptionSelection_pkey" PRIMARY KEY ("variantId","optionId")
);

-- CreateTable
CREATE TABLE "VariantImage" (
    "variantId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "src" TEXT NOT NULL,
    "alt" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "VariantImage_pkey" PRIMARY KEY ("variantId","position")
);

-- CreateTable
CREATE TABLE "DeviceModel" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lookupKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DeviceModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceModelAlias" (
    "lookupKey" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "DeviceModelAlias_pkey" PRIMARY KEY ("lookupKey")
);

-- CreateTable
CREATE TABLE "VariantCompatibility" (
    "variantId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,

    CONSTRAINT "VariantCompatibility_pkey" PRIMARY KEY ("variantId","modelId")
);

-- CreateIndex
CREATE INDEX "ProductOption_productId_position_id_idx" ON "ProductOption"("productId", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOption_productId_key_key" ON "ProductOption"("productId", "key");

-- CreateIndex
CREATE INDEX "ProductOptionValue_productId_optionId_position_id_idx" ON "ProductOptionValue"("productId", "optionId", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOptionValue_productId_optionId_value_key" ON "ProductOptionValue"("productId", "optionId", "value");

-- CreateIndex
CREATE INDEX "VariantOptionSelection_productId_optionId_optionValueId_var_idx" ON "VariantOptionSelection"("productId", "optionId", "optionValueId", "variantId");

-- CreateIndex
CREATE INDEX "VariantImage_src_idx" ON "VariantImage"("src");

-- CreateIndex
CREATE UNIQUE INDEX "VariantImage_variantId_src_key" ON "VariantImage"("variantId", "src");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_lookupKey_key" ON "DeviceModel"("lookupKey");

-- CreateIndex
CREATE INDEX "DeviceModelAlias_modelId_idx" ON "DeviceModelAlias"("modelId");

-- CreateIndex
CREATE INDEX "VariantCompatibility_modelId_variantId_idx" ON "VariantCompatibility"("modelId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_id_productId_key" ON "Variant"("id", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_productId_optionSignature_key" ON "Variant"("productId", "optionSignature");

-- AddForeignKey
ALTER TABLE "ProductTranslation" ADD CONSTRAINT "ProductTranslation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOptionValue" ADD CONSTRAINT "ProductOptionValue_productId_optionId_fkey" FOREIGN KEY ("productId", "optionId") REFERENCES "ProductOption"("productId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantOptionSelection" ADD CONSTRAINT "VariantOptionSelection_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "Variant"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantOptionSelection" ADD CONSTRAINT "VariantOptionSelection_productId_optionId_optionValueId_fkey" FOREIGN KEY ("productId", "optionId", "optionValueId") REFERENCES "ProductOptionValue"("productId", "optionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantImage" ADD CONSTRAINT "VariantImage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceModelAlias" ADD CONSTRAINT "DeviceModelAlias_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "DeviceModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCompatibility" ADD CONSTRAINT "VariantCompatibility_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantCompatibility" ADD CONSTRAINT "VariantCompatibility_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "DeviceModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Historic variants retain a null signature. Structured variants reserve each tuple for its issued SKU.
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_attributeValues_object_check"
    CHECK ("attributeValues" IS NULL OR jsonb_typeof("attributeValues") = 'object');

ALTER TABLE "Variant"
  ADD CONSTRAINT "Variant_foundation_sku_check"
    CHECK ("optionSignature" IS NULL OR sku = upper(sku)),
  ADD CONSTRAINT "Variant_default_check"
    CHECK (NOT "isDefault" OR (active AND "archivedAt" IS NULL AND "optionSignature" IS NOT NULL)),
  ADD CONSTRAINT "Variant_archive_check"
    CHECK ("archivedAt" IS NULL OR (NOT active AND "optionSignature" IS NOT NULL)),
  ADD CONSTRAINT "Variant_attributeValues_object_check"
    CHECK ("attributeValues" IS NULL OR jsonb_typeof("attributeValues") = 'object');

CREATE UNIQUE INDEX "Variant_one_default_per_product"
  ON "Variant" ("productId") WHERE "isDefault";

ALTER TABLE "ProductOption"
  ADD CONSTRAINT "ProductOption_position_check" CHECK (position >= 0);

ALTER TABLE "ProductOptionValue"
  ADD CONSTRAINT "ProductOptionValue_position_check" CHECK (position >= 0);

ALTER TABLE "ProductTranslation"
  ADD CONSTRAINT "ProductTranslation_locale_check" CHECK (length(locale) > 0);

-- Primary images retain the existing gallery ordering and reference shared assets.
CREATE UNIQUE INDEX "ProductImage_one_primary_per_product"
  ON "ProductImage" ("productId") WHERE "isPrimary";

ALTER TABLE "VariantImage"
  ADD CONSTRAINT "VariantImage_position_check" CHECK (position >= 0);

CREATE UNIQUE INDEX "VariantImage_one_primary_per_variant"
  ON "VariantImage" ("variantId") WHERE "isPrimary";

ALTER TABLE "DeviceModel"
  ADD CONSTRAINT "DeviceModel_lookupKey_check" CHECK (length("lookupKey") > 0),
  ADD CONSTRAINT "DeviceModel_revision_check" CHECK (revision >= 0);

ALTER TABLE "DeviceModelAlias"
  ADD CONSTRAINT "DeviceModelAlias_lookupKey_check" CHECK (length("lookupKey") > 0);

COMMIT;
