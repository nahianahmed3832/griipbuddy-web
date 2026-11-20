BEGIN;

-- CreateEnum
CREATE TYPE "DepartmentKind" AS ENUM ('DEPARTMENT', 'CATEGORY', 'SUBCATEGORY');

-- CreateEnum
CREATE TYPE "CatalogAttributeScope" AS ENUM ('PRODUCT', 'VARIANT');

-- CreateEnum
CREATE TYPE "CatalogAttributeType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'ENUM');

-- CreateEnum
CREATE TYPE "MenuPage" AS ENUM ('HOME', 'SEARCH', 'SHOP');

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "kind" "DepartmentKind",
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "state" "PublicationState" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "DepartmentTranslation" (
    "departmentId" TEXT NOT NULL,
    "locale" VARCHAR(35) NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "slug" VARCHAR(120),

    CONSTRAINT "DepartmentTranslation_pkey" PRIMARY KEY ("departmentId","locale")
);

-- CreateTable
CREATE TABLE "DepartmentSlugAlias" (
    "locale" VARCHAR(35) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "DepartmentSlugAlias_pkey" PRIMARY KEY ("locale","slug")
);

-- CreateTable
CREATE TABLE "DepartmentMarketPresentation" (
    "departmentId" TEXT NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "visibleInNavigation" BOOLEAN,
    "position" INTEGER,
    "imageSrc" TEXT,
    "imageAlt" TEXT,

    CONSTRAINT "DepartmentMarketPresentation_pkey" PRIMARY KEY ("departmentId","marketId")
);

-- CreateTable
CREATE TABLE "CatalogAttributeDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "CatalogAttributeScope" NOT NULL,
    "dataType" "CatalogAttributeType" NOT NULL,
    "allowedValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "variantOptionKey" TEXT,

    CONSTRAINT "CatalogAttributeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryAttributeTemplate" (
    "departmentId" TEXT NOT NULL,
    "attributeId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "inheritable" BOOLEAN NOT NULL DEFAULT true,
    "excluded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CategoryAttributeTemplate_pkey" PRIMARY KEY ("departmentId","attributeId")
);

-- CreateTable
CREATE TABLE "ProductSecondaryCategory" (
    "productId" TEXT NOT NULL,
    "primaryDepartmentId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "ProductSecondaryCategory_pkey" PRIMARY KEY ("productId","departmentId")
);

-- CreateTable
CREATE TABLE "MarketMenu" (
    "id" TEXT NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MarketMenu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketMenuItem" (
    "menuId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "departmentId" TEXT,
    "collectionId" TEXT,
    "page" "MenuPage",

    CONSTRAINT "MarketMenuItem_pkey" PRIMARY KEY ("menuId","position")
);

-- CreateIndex
CREATE INDEX "DepartmentTranslation_slug_idx" ON "DepartmentTranslation"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentTranslation_locale_slug_key" ON "DepartmentTranslation"("locale", "slug");

-- CreateIndex
CREATE INDEX "DepartmentSlugAlias_slug_idx" ON "DepartmentSlugAlias"("slug");

-- CreateIndex
CREATE INDEX "DepartmentSlugAlias_departmentId_idx" ON "DepartmentSlugAlias"("departmentId");

-- CreateIndex
CREATE INDEX "DepartmentMarketPresentation_marketId_visibleInNavigation_p_idx" ON "DepartmentMarketPresentation"("marketId", "visibleInNavigation", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogAttributeDefinition_variantOptionKey_key" ON "CatalogAttributeDefinition"("variantOptionKey");

-- CreateIndex
CREATE INDEX "CategoryAttributeTemplate_attributeId_idx" ON "CategoryAttributeTemplate"("attributeId");

-- CreateIndex
CREATE INDEX "ProductSecondaryCategory_departmentId_productId_idx" ON "ProductSecondaryCategory"("departmentId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketMenu_marketId_key_key" ON "MarketMenu"("marketId", "key");

-- CreateIndex
CREATE INDEX "MarketMenuItem_departmentId_idx" ON "MarketMenuItem"("departmentId");

-- CreateIndex
CREATE INDEX "MarketMenuItem_collectionId_idx" ON "MarketMenuItem"("collectionId");

-- CreateIndex
CREATE INDEX "Department_parentId_position_id_idx" ON "Department"("parentId", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_id_departmentId_key" ON "Product"("id", "departmentId");

-- AddForeignKey
ALTER TABLE "DepartmentTranslation" ADD CONSTRAINT "DepartmentTranslation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentSlugAlias" ADD CONSTRAINT "DepartmentSlugAlias_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMarketPresentation" ADD CONSTRAINT "DepartmentMarketPresentation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAttributeTemplate" ADD CONSTRAINT "CategoryAttributeTemplate_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAttributeTemplate" ADD CONSTRAINT "CategoryAttributeTemplate_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "CatalogAttributeDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSecondaryCategory" ADD CONSTRAINT "ProductSecondaryCategory_productId_primaryDepartmentId_fkey" FOREIGN KEY ("productId", "primaryDepartmentId") REFERENCES "Product"("id", "departmentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSecondaryCategory" ADD CONSTRAINT "ProductSecondaryCategory_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketMenuItem" ADD CONSTRAINT "MarketMenuItem_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "MarketMenu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketMenuItem" ADD CONSTRAINT "MarketMenuItem_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketMenuItem" ADD CONSTRAINT "MarketMenuItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Older rows keep their original shape until the catalog backfill.
ALTER TABLE "Department"
  ADD CONSTRAINT "Department_typed_shape_check" CHECK (
    "kind" IS NULL OR (
      position BETWEEN 0 AND 9999
      AND "revision" >= 0
      AND (
        ("kind" = 'DEPARTMENT' AND "parentId" IS NULL)
        OR ("kind" <> 'DEPARTMENT' AND "parentId" IS NOT NULL AND "parentId" <> id)
      )
    )
  );

-- The compound FK keeps the primary ID current even when older writers change it.
ALTER TABLE "ProductSecondaryCategory"
  ADD CONSTRAINT "ProductSecondaryCategory_distinct_primary_check"
    CHECK ("departmentId" <> "primaryDepartmentId");

ALTER TABLE "DepartmentTranslation"
  ADD CONSTRAINT "DepartmentTranslation_locale_check" CHECK (length(locale) > 0),
  ADD CONSTRAINT "DepartmentTranslation_slug_check" CHECK (slug IS NULL OR length(slug) > 0);

ALTER TABLE "DepartmentSlugAlias"
  ADD CONSTRAINT "DepartmentSlugAlias_slug_check" CHECK (length(slug) > 0);

ALTER TABLE "DepartmentMarketPresentation"
  ADD CONSTRAINT "DepartmentMarketPresentation_position_check" CHECK (position BETWEEN 0 AND 9999),
  ADD CONSTRAINT "DepartmentMarketPresentation_image_check" CHECK (("imageSrc" IS NULL) = ("imageAlt" IS NULL));

ALTER TABLE "CatalogAttributeDefinition"
  ALTER COLUMN "allowedValues" SET NOT NULL,
  ADD CONSTRAINT "CatalogAttributeDefinition_values_check" CHECK (
    ("dataType" = 'ENUM' AND cardinality("allowedValues") > 0)
    OR ("dataType" <> 'ENUM' AND cardinality("allowedValues") = 0)
  ),
  ADD CONSTRAINT "CatalogAttributeDefinition_option_check" CHECK (
    "variantOptionKey" IS NULL OR ("scope" = 'VARIANT' AND "dataType" IN ('TEXT', 'ENUM'))
  );

ALTER TABLE "CategoryAttributeTemplate"
  ADD CONSTRAINT "CategoryAttributeTemplate_position_check" CHECK (position BETWEEN 0 AND 9999);

ALTER TABLE "MarketMenu"
  ADD CONSTRAINT "MarketMenu_revision_check" CHECK (revision >= 0);

ALTER TABLE "MarketMenuItem"
  ADD CONSTRAINT "MarketMenuItem_position_check" CHECK (position >= 0),
  ADD CONSTRAINT "MarketMenuItem_target_check" CHECK (num_nonnulls("departmentId", "collectionId", page) = 1);

COMMIT;
