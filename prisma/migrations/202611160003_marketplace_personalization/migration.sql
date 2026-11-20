ALTER TABLE "Product"
  ADD COLUMN "personalizationPrompt" VARCHAR(180),
  ADD COLUMN "personalizationRequired" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "OrderItem"
  ADD COLUMN "personalization" VARCHAR(120) NOT NULL DEFAULT '';

CREATE UNIQUE INDEX "OrderItem_orderId_variantId_personalization_key"
  ON "OrderItem" ("orderId", "variantId", "personalization");
DROP INDEX "OrderItem_orderId_variantId_key";
