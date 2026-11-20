BEGIN;

ALTER TABLE "Department"
  ADD COLUMN "bannerSrc" VARCHAR(100),
  ADD COLUMN "bannerAlt" VARCHAR(180),
  ADD COLUMN "seoTitle" VARCHAR(120),
  ADD COLUMN "seoDescription" VARCHAR(320),
  ADD CONSTRAINT "Department_banner_pair" CHECK (("bannerSrc" IS NULL) = ("bannerAlt" IS NULL));

COMMIT;
