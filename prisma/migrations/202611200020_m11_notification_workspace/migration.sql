CREATE TABLE "NotificationInboxReceipt" (
    "audience" VARCHAR(12) NOT NULL,
    "actorId" TEXT NOT NULL,
    "shopScope" VARCHAR(36) NOT NULL DEFAULT '',
    "marketId" "MarketCode" NOT NULL,
    "eventKey" VARCHAR(80) NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    CONSTRAINT "NotificationInboxReceipt_pkey" PRIMARY KEY ("audience", "actorId", "shopScope", "marketId", "eventKey")
);

CREATE TABLE "NotificationOrderPolicy" (
    "marketId" "MarketCode" PRIMARY KEY,
    "placed" BOOLEAN NOT NULL DEFAULT true,
    "fulfillment" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TYPE "NotificationTestState" AS ENUM ('QUEUED', 'RETRY_PENDING', 'SINK_ACCEPTED', 'FAILED');

CREATE TABLE "NotificationTestJob" (
    "id" UUID PRIMARY KEY,
    "marketId" "MarketCode" NOT NULL,
    "operationId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "recipientHash" CHAR(64) NOT NULL,
    "locale" VARCHAR(35) NOT NULL,
    "subject" VARCHAR(120) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "state" "NotificationTestState" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationTestJob_marketId_operationId_key" UNIQUE ("marketId", "operationId")
);
CREATE INDEX "NotificationTestJob_state_nextAt_id_idx" ON "NotificationTestJob"("state", "nextAt", "id");
CREATE INDEX "NotificationTestJob_marketId_createdAt_idx" ON "NotificationTestJob"("marketId", "createdAt");

CREATE TABLE "NotificationTestAttempt" (
    "jobId" UUID NOT NULL REFERENCES "NotificationTestJob"("id") ON DELETE CASCADE,
    "number" INTEGER NOT NULL,
    "outcome" "NotificationTestState" NOT NULL,
    "reason" VARCHAR(45),
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationTestAttempt_pkey" PRIMARY KEY ("jobId", "number")
);

CREATE TABLE "NotificationTestSink" (
    "jobId" UUID PRIMARY KEY REFERENCES "NotificationTestJob"("id") ON DELETE CASCADE,
    "marketId" "MarketCode" NOT NULL,
    "recipientHash" CHAR(64) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TYPE "AuditAction" ADD VALUE 'NOTIFICATION_POLICY_CHANGED';
