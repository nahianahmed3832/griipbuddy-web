\set ON_ERROR_STOP on
BEGIN;
DO $$
BEGIN
  IF NOT ((current_database() = 'griipbuddy_marketplace_dev' AND current_user = 'griipbuddy_marketplace')
       OR (current_database() = 'griipbuddy_dev' AND current_user = 'marketplace_local')) THEN
    RAISE EXCEPTION 'Expected the isolated marketplace database';
  END IF;
END $$;
INSERT INTO "CheckoutPolicy" ("marketId","countryCode","currency","enabled","codEnabled","taxTreatment","taxBasisPoints","taxLabel")
VALUES ('bd','BD','BDT',true,true,'MERCHANDISE_RATE',0,'Tax')
ON CONFLICT ("marketId") DO NOTHING;
INSERT INTO "DeliveryZone" ("marketId","district","districtLabel","method","label","chargeMinor","guidance")
VALUES
  ('bd','dhaka','Dhaka','standard','Standard delivery',7000,'1–2 business days'),
  ('bd','outside-dhaka','Outside Dhaka','standard','Standard delivery',10000,'2–3 business days')
ON CONFLICT ("marketId","district","method") DO NOTHING;

-- USD sample prices for the isolated US sandbox preview. Existing offers take precedence.
INSERT INTO "MarketOffer" ("variantId","marketId","currency","amountMinor","eligible")
SELECT v.id,'us','USD',sample.amount,true
FROM (VALUES
  ('v-69c676ab036e5c54d2c30317',1295),
  ('v-69c676e7036e5c54d2c30320',1295),
  ('v-69b625ab482d3ab6681a8c73',1495),
  ('v-6a1fa167c91498b77bde2880',1095)
) AS sample(id,amount)
JOIN "Variant" AS v ON v.id = sample.id
JOIN "Product" AS p ON p.id = v."productId"
WHERE NOT p.demo AND p."marketplaceShopId" IS NULL AND p.publication = 'ACTIVE' AND v.active
ON CONFLICT ("variantId","marketId") DO NOTHING;
COMMIT;
