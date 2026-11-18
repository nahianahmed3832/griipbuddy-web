DO $$
BEGIN
    IF NOT (
        (current_database() = 'griipbuddy_hybrid_demo' AND current_user = 'griipbuddy_demo')
        OR (current_database() = 'griipbuddy_hybrid_test'
            AND (inet_server_addr() IS NULL OR inet_server_addr() IN ('127.0.0.1'::inet, '::1'::inet)))
    ) THEN
        RETURN;
    END IF;

    -- Use the same lock as staff market settings. An existing checkout policy stays authoritative.
    PERFORM pg_advisory_xact_lock(hashtext('bd'), 38);
    INSERT INTO "CheckoutPolicy" (
        "marketId", "countryCode", "currency", "enabled", "codEnabled", "taxTreatment", "taxBasisPoints", "taxLabel"
    ) VALUES ('bd', 'BD', 'BDT', true, true, 'MERCHANDISE_RATE', 500, 'Demo tax (5%)')
    ON CONFLICT ("marketId") DO NOTHING;
    PERFORM 1 FROM "CheckoutPolicy" WHERE "marketId" = 'bd' FOR UPDATE;

    -- The 64 districts listed by the Bangladesh National Portal.
    -- https://bangladesh.gov.bd/views/district-list/
    INSERT INTO "DeliveryZone" AS zone (
        "marketId", "district", "districtLabel", "method", "label", "chargeMinor", "enabled", "codEligible"
    )
    SELECT
        'bd', district.id, district.name, 'standard', 'Standard delivery',
        CASE WHEN district.id = 'dhaka' THEN 8000 ELSE 12000 END, true, true
    FROM (VALUES
        ('bagerhat', 'Bagerhat'),
        ('bandarban', 'Bandarban'),
        ('barguna', 'Barguna'),
        ('barishal', 'Barishal'),
        ('bhola', 'Bhola'),
        ('bogura', 'Bogura'),
        ('brahmanbaria', 'Brahmanbaria'),
        ('chandpur', 'Chandpur'),
        ('chapainawabganj', 'Chapainawabganj'),
        ('chattogram', 'Chattogram'),
        ('chuadanga', 'Chuadanga'),
        ('coxs-bazar', 'Cox''s Bazar'),
        ('cumilla', 'Cumilla'),
        ('dhaka', 'Dhaka'),
        ('dinajpur', 'Dinajpur'),
        ('faridpur', 'Faridpur'),
        ('feni', 'Feni'),
        ('gaibandha', 'Gaibandha'),
        ('gazipur', 'Gazipur'),
        ('gopalganj', 'Gopalganj'),
        ('habiganj', 'Habiganj'),
        ('jamalpur', 'Jamalpur'),
        ('jashore', 'Jashore'),
        ('jhalakathi', 'Jhalakathi'),
        ('jhenaidah', 'Jhenaidah'),
        ('joypurhat', 'Joypurhat'),
        ('khagrachhari', 'Khagrachhari'),
        ('khulna', 'Khulna'),
        ('kishoreganj', 'Kishoreganj'),
        ('kurigram', 'Kurigram'),
        ('kushtia', 'Kushtia'),
        ('lakshmipur', 'Lakshmipur'),
        ('lalmonirhat', 'Lalmonirhat'),
        ('madaripur', 'Madaripur'),
        ('magura', 'Magura'),
        ('manikganj', 'Manikganj'),
        ('meherpur', 'Meherpur'),
        ('moulvibazar', 'Moulvibazar'),
        ('munshiganj', 'Munshiganj'),
        ('mymensingh', 'Mymensingh'),
        ('naogaon', 'Naogaon'),
        ('narail', 'Narail'),
        ('narayanganj', 'Narayanganj'),
        ('narsingdi', 'Narsingdi'),
        ('natore', 'Natore'),
        ('netrokona', 'Netrokona'),
        ('nilphamari', 'Nilphamari'),
        ('noakhali', 'Noakhali'),
        ('pabna', 'Pabna'),
        ('panchagarh', 'Panchagarh'),
        ('patuakhali', 'Patuakhali'),
        ('pirojpur', 'Pirojpur'),
        ('rajbari', 'Rajbari'),
        ('rajshahi', 'Rajshahi'),
        ('rangamati', 'Rangamati'),
        ('rangpur', 'Rangpur'),
        ('satkhira', 'Satkhira'),
        ('shariatpur', 'Shariatpur'),
        ('sherpur', 'Sherpur'),
        ('sirajganj', 'Sirajganj'),
        ('sunamganj', 'Sunamganj'),
        ('sylhet', 'Sylhet'),
        ('tangail', 'Tangail'),
        ('thakurgaon', 'Thakurgaon')
    ) AS district(id, name)
    ON CONFLICT ("marketId", "district", "method") DO UPDATE SET
        "districtLabel" = EXCLUDED."districtLabel",
        "chargeMinor" = EXCLUDED."chargeMinor",
        "enabled" = EXCLUDED."enabled",
        "codEligible" = EXCLUDED."codEligible",
        "revision" = zone."revision" + 1
    WHERE (zone."districtLabel", zone."chargeMinor", zone."enabled", zone."codEligible")
        IS DISTINCT FROM (EXCLUDED."districtLabel", EXCLUDED."chargeMinor", EXCLUDED."enabled", EXCLUDED."codEligible");
END;
$$;
