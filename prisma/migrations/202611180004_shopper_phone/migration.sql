ALTER TABLE "Shopper"
  ADD COLUMN "phoneNumber" TEXT,
  ADD COLUMN "phoneNumberVerified" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Shopper_phoneNumber_key" ON "Shopper"("phoneNumber");
