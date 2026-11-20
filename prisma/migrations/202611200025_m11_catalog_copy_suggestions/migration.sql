CREATE TABLE "CatalogCopySuggestion" (
  "operationId" UUID PRIMARY KEY,
  "actorKind" VARCHAR(8) NOT NULL CHECK ("actorKind" IN ('staff', 'seller')),
  "actorId" TEXT NOT NULL,
  "shopId" UUID,
  "marketId" "MarketCode" NOT NULL,
  "productId" TEXT NOT NULL,
  "productRevision" INTEGER NOT NULL CHECK ("productRevision" >= 0),
  "purpose" VARCHAR(16) NOT NULL CHECK ("purpose" IN ('summary', 'description')),
  "state" VARCHAR(12) NOT NULL CHECK ("state" IN ('SAVED', 'UNAVAILABLE')),
  "body" VARCHAR(900),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("actorKind" = 'seller') = ("shopId" IS NOT NULL)),
  CHECK (("state" = 'SAVED') = ("body" IS NOT NULL))
);
CREATE INDEX "CatalogCopySuggestion_actor_scope_created_idx"
  ON "CatalogCopySuggestion" ("actorKind", "actorId", "marketId", "shopId", "createdAt");
