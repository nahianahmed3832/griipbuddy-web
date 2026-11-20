ALTER TABLE "Department" ADD COLUMN "parentId" TEXT;
ALTER TABLE "Department"
  ADD CONSTRAINT "Department_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Department_parentId_position_idx" ON "Department" ("parentId", "position");

-- Keep imported category URLs and product assignments while adding a shared department above them.
INSERT INTO "Department" ("id", "slug", "name", "shortName", "description", "imageSrc", "imageAlt", "position")
SELECT 'd-mobile-tech', 'mobile-tech', 'Mobile & Tech', 'Mobile & Tech',
       'Shop phone cases, screen protection and accessories.',
       "imageSrc", "imageAlt", "position"
FROM "Department"
WHERE "slug" = 'phone-cases'
ON CONFLICT DO NOTHING;

UPDATE "Department"
SET "parentId" = 'd-mobile-tech'
WHERE "slug" IN ('phone-cases', 'screen-and-camera-protectors', 'tech-accessories', 'other-models', 'combo-offer')
  AND EXISTS (SELECT 1 FROM "Department" WHERE "id" = 'd-mobile-tech' AND "slug" = 'mobile-tech');
