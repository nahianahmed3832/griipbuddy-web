CREATE TABLE "NewsletterRequest" (
    "email" VARCHAR(254) NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "locale" VARCHAR(32) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NewsletterRequest_pkey" PRIMARY KEY ("marketId", "email")
);
