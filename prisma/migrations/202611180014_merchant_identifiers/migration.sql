ALTER TABLE "Product"
  ADD COLUMN "brand" VARCHAR(70),
  ADD CONSTRAINT "Product_brand_check" CHECK ("brand" IS NULL OR btrim("brand") <> '');

ALTER TABLE "Variant"
  ADD COLUMN "gtin" VARCHAR(14),
  ADD COLUMN "mpn" VARCHAR(70),
  ADD COLUMN "identifiersNotAssigned" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "Variant_gtin_format_check" CHECK ("gtin" IS NULL OR "gtin" ~ '^[0-9]{8}$|^[0-9]{12,14}$'),
  ADD CONSTRAINT "Variant_mpn_check" CHECK ("mpn" IS NULL OR btrim("mpn") <> ''),
  ADD CONSTRAINT "Variant_confirmed_identifier_absence_check" CHECK (NOT "identifiersNotAssigned" OR ("gtin" IS NULL AND "mpn" IS NULL));
