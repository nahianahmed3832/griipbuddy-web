ALTER TABLE "StaffAccess"
  ADD COLUMN "marketIds" "MarketCode"[] NOT NULL DEFAULT ARRAY['bd', 'us']::"MarketCode"[];
