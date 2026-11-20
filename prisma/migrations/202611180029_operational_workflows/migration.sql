CREATE TYPE "OperationalWorkflowKind" AS ENUM ('MARKET_TEST', 'HOMEPAGE', 'PURCHASING', 'CONVERSION', 'LISTING');
CREATE TYPE "OperationalWorkflowAction" AS ENUM ('HOME_DRAFT', 'HOME_PUBLISH', 'HOME_ROLLBACK', 'PURCHASE_PROPOSAL', 'TEST_PLAN', 'CONVERSION_TASK', 'LISTING_DRAFT');
CREATE TYPE "OperationalWorkflowStatus" AS ENUM ('DRAFT', 'READY', 'AWAITING_DECISION', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "OperationalWorkflowJobStatus" AS ENUM ('QUEUED', 'LEASED', 'DONE', 'DEAD', 'CANCELLED');
CREATE TYPE "OperationalWorkflowOutcome" AS ENUM ('SUCCESSFUL', 'UNSUCCESSFUL', 'INCONCLUSIVE');

CREATE TABLE "OperationalWorkflow" (
    "id" UUID NOT NULL,
    "marketId" "MarketCode" NOT NULL,
    "test" BOOLEAN NOT NULL,
    "kind" "OperationalWorkflowKind" NOT NULL,
    "action" "OperationalWorkflowAction" NOT NULL,
    "status" "OperationalWorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "ownerId" TEXT NOT NULL,
    "agentRole" VARCHAR(24),
    "requestKey" VARCHAR(120) NOT NULL,
    "inputFingerprint" CHAR(64) NOT NULL,
    "targetKey" VARCHAR(240) NOT NULL,
    "resourceKey" VARCHAR(260) NOT NULL,
    "resourceHeld" BOOLEAN NOT NULL DEFAULT false,
    "policyVersion" VARCHAR(120) NOT NULL,
    "approvedBy" TEXT,
    "approvedPolicy" VARCHAR(120),
    "title" VARCHAR(220) NOT NULL,
    "expectedOutcome" VARCHAR(500) NOT NULL,
    "uncertainty" VARCHAR(500) NOT NULL,
    "evidence" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "benefit" INTEGER,
    "confidence" INTEGER,
    "effort" INTEGER,
    "stock" INTEGER,
    "budgetMinor" INTEGER,
    "budgetCurrency" "CurrencyCode",
    "budgetLedgerKey" VARCHAR(120),
    "committedMinor" INTEGER NOT NULL DEFAULT 0,
    "spentMinor" INTEGER NOT NULL DEFAULT 0,
    "evidenceExpiresAt" TIMESTAMP(3) NOT NULL,
    "outcomeReviewAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "blockReason" VARCHAR(500),
    "result" JSONB,
    CONSTRAINT "OperationalWorkflow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalWorkflow_nonnegative_budget" CHECK (
      "committedMinor" >= 0 AND "spentMinor" >= 0 AND
      "committedMinor"::bigint + "spentMinor" <= COALESCE("budgetMinor", 0) AND
      (("budgetMinor" IS NULL AND "budgetCurrency" IS NULL AND "budgetLedgerKey" IS NULL) OR
       ("budgetMinor" >= 0 AND "budgetCurrency" IS NOT NULL AND "budgetLedgerKey" IS NOT NULL))
    )
);
CREATE UNIQUE INDEX "OperationalWorkflow_marketId_test_requestKey_key" ON "OperationalWorkflow" ("marketId", "test", "requestKey");
CREATE UNIQUE INDEX "OperationalWorkflow_active_resource_key" ON "OperationalWorkflow" ("test", "resourceKey") WHERE "resourceHeld";
CREATE INDEX "OperationalWorkflow_marketId_test_status_createdAt_idx" ON "OperationalWorkflow" ("marketId", "test", "status", "createdAt");
CREATE INDEX "OperationalWorkflow_test_budgetLedgerKey_budgetCurrency_idx" ON "OperationalWorkflow" ("test", "budgetLedgerKey", "budgetCurrency");
CREATE INDEX "OperationalWorkflow_status_outcomeReviewAt_idx" ON "OperationalWorkflow" ("status", "outcomeReviewAt");

CREATE TABLE "OperationalWorkflowJob" (
    "workflowId" UUID NOT NULL,
    "status" "OperationalWorkflowJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" UUID,
    "workerId" VARCHAR(100),
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "lastError" VARCHAR(500),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperationalWorkflowJob_pkey" PRIMARY KEY ("workflowId"),
    CONSTRAINT "OperationalWorkflowJob_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "OperationalWorkflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OperationalWorkflowJob_retry_bounds" CHECK ("attempts" >= 0 AND "attempts" <= "maxAttempts" AND "maxAttempts" BETWEEN 1 AND 5),
    CONSTRAINT "OperationalWorkflowJob_lease_state" CHECK (
       ("status" = 'LEASED' AND "leaseUntil" IS NOT NULL AND "leaseToken" IS NOT NULL) OR
       ("status" <> 'LEASED' AND "leaseUntil" IS NULL AND "leaseToken" IS NULL)
    )
);
CREATE INDEX "OperationalWorkflowJob_status_availableAt_idx" ON "OperationalWorkflowJob" ("status", "availableAt");
CREATE INDEX "OperationalWorkflowJob_status_leaseUntil_idx" ON "OperationalWorkflowJob" ("status", "leaseUntil");

CREATE TABLE "OperationalWorkflowEvent" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "actorId" TEXT,
    "event" VARCHAR(48) NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperationalWorkflowEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalWorkflowEvent_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "OperationalWorkflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "OperationalWorkflowEvent_workflowId_createdAt_idx" ON "OperationalWorkflowEvent" ("workflowId", "createdAt");

CREATE TABLE "OperationalWorkflowReview" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "reviewKey" VARCHAR(120) NOT NULL,
    "outcome" "OperationalWorkflowOutcome" NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperationalWorkflowReview_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OperationalWorkflowReview_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "OperationalWorkflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OperationalWorkflowReview_workflowId_reviewKey_key" ON "OperationalWorkflowReview" ("workflowId", "reviewKey");
CREATE INDEX "OperationalWorkflowReview_workflowId_createdAt_idx" ON "OperationalWorkflowReview" ("workflowId", "createdAt");
