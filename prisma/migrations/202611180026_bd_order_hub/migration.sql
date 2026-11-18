CREATE TABLE "BangladeshLegacyAccount" (
    "shopperId" TEXT PRIMARY KEY REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "customerId" VARCHAR(24) NOT NULL UNIQUE,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BangladeshOrderGrant" (
    "kind" VARCHAR(12) NOT NULL CHECK ("kind" IN ('order', 'preorder')),
    "sourceId" VARCHAR(24) NOT NULL,
    "shopperId" TEXT NOT NULL REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("kind", "sourceId")
);
CREATE INDEX "BangladeshOrderGrant_shopperId_claimedAt_idx" ON "BangladeshOrderGrant"("shopperId", "claimedAt");

CREATE TABLE "BangladeshOrderChallenge" (
    "id" UUID PRIMARY KEY,
    "shopperId" TEXT NOT NULL REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "target" VARCHAR(12) CHECK ("target" IN ('native', 'order', 'preorder')),
    "sourceId" VARCHAR(36),
    "codeDigest" VARCHAR(64) NOT NULL,
    "inputDigest" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3)
);
CREATE INDEX "BangladeshOrderChallenge_expiresAt_idx" ON "BangladeshOrderChallenge"("expiresAt");
