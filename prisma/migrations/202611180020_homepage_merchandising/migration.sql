CREATE TABLE "StaffMarketAccess" (
    "userId" TEXT NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "merchandising" BOOLEAN NOT NULL DEFAULT false,
    "reporting" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "StaffMarketAccess_pkey" PRIMARY KEY ("userId", "marketId"),
    CONSTRAINT "StaffMarketAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "StaffAccess"("userId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HomepageContent" (
    "key" VARCHAR(60) NOT NULL,
    "marketId" "MarketCode",
    "locale" VARCHAR(35),
    "draft" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "publishedId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HomepageContent_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "HomepageRelease" (
    "id" UUID NOT NULL,
    "scopeKey" VARCHAR(60) NOT NULL,
    "content" JSONB NOT NULL,
    "actorId" TEXT NOT NULL,
    "restoredFrom" UUID,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HomepageRelease_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HomepageRelease_scopeKey_fkey" FOREIGN KEY ("scopeKey") REFERENCES "HomepageContent"("key") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "HomepageContent_publishedId_key" ON "HomepageContent"("publishedId");
CREATE INDEX "HomepageRelease_scopeKey_publishedAt_idx" ON "HomepageRelease"("scopeKey", "publishedAt");
ALTER TABLE "HomepageContent" ADD CONSTRAINT "HomepageContent_publishedId_fkey"
    FOREIGN KEY ("publishedId") REFERENCES "HomepageRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
