-- Run in the local or Hostinger pilot storefront database.
BEGIN;
DO $$
BEGIN
  IF (current_database(), current_user::text) NOT IN (
    ('griipbuddy_test', 'pilot'), ('griipbuddy_pilot_stage', 'griipbuddy_pilot')
  ) THEN
    RAISE EXCEPTION 'Use the dedicated pilot database';
  END IF;
END $$;

INSERT INTO "Department" ("id", "slug", "name", "shortName", "description", "imageSrc", "imageAlt", "position")
VALUES ('pilot-tech', 'pilot-tech', 'Pilot accessories', 'Pilot accessories', 'Isolated catalog fixture',
        '/editorial/tech.webp', 'Electronics accessories', 1) ON CONFLICT DO NOTHING;

INSERT INTO "Product" ("id", "slug", "departmentId", "name", "description", "specifications", "keywords",
                       "addedOn", "position", "publication", "demo")
VALUES ('p-00000000000000000000f101', 'pilot-camera-cover', 'pilot-tech', 'Pilot camera cover',
        'Synthetic product for the Bangladesh operating trial.', '[]', ARRAY['pilot', 'camera', 'cover'],
        CURRENT_DATE, 1, 'ACTIVE', true) ON CONFLICT DO NOTHING;

INSERT INTO "ProductImage" ("productId", "position", "src", "alt")
VALUES ('p-00000000000000000000f101', 1, '/editorial/tech.webp', 'Pilot accessories') ON CONFLICT DO NOTHING;

INSERT INTO "Variant" ("id", "sku", "productId", "options", "label", "position")
VALUES ('v-00000000000000000000f102', 'OPS-TEST-RECEIVE-BLACK', 'p-00000000000000000000f101',
        '{"Color":"Black"}', 'Black', 1) ON CONFLICT DO NOTHING;

INSERT INTO "Inventory" ("variantId", "available", "updatedAt")
VALUES ('v-00000000000000000000f102', 0, now()) ON CONFLICT DO NOTHING;

INSERT INTO "MarketOffer" ("variantId", "marketId", "currency", "amountMinor")
VALUES ('v-00000000000000000000f102', 'bd', 'BDT', 50000) ON CONFLICT DO NOTHING;
COMMIT;
