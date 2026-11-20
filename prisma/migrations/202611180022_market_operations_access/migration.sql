ALTER TABLE "StaffMarketAccess" ADD COLUMN "operations" BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing packing accounts were provisioned for the original domestic queue.
INSERT INTO "StaffMarketAccess" ("userId", "marketId", "operations")
SELECT "userId", 'bd'::"MarketCode", TRUE
FROM "StaffAccess" WHERE "role" = 'PACKER'
ON CONFLICT ("userId", "marketId") DO UPDATE SET "operations" = TRUE;
