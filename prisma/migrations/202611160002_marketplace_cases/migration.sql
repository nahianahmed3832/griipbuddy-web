CREATE TYPE "OrderCaseKind" AS ENUM ('RETURN', 'DISPUTE');
CREATE TYPE "OrderCaseStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RETURN_APPROVED', 'DECLINED', 'RESOLVED', 'WITHDRAWN');

CREATE TABLE "OrderCase" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" "OrderCaseKind" NOT NULL,
    "status" "OrderCaseStatus" NOT NULL DEFAULT 'OPEN',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderCase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderCase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "OrderCaseEvent" (
    "id" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "status" "OrderCaseStatus" NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderCaseEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderCaseEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "OrderCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderCaseEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "OrderCase_orderId_updatedAt_idx" ON "OrderCase"("orderId", "updatedAt");
CREATE INDEX "OrderCase_status_updatedAt_idx" ON "OrderCase"("status", "updatedAt");
CREATE UNIQUE INDEX "OrderCaseEvent_caseId_revision_key" ON "OrderCaseEvent"("caseId", "revision");

CREATE UNIQUE INDEX "OrderCase_one_open_per_kind" ON "OrderCase"("orderId", "kind")
    WHERE "status" IN ('OPEN', 'IN_REVIEW', 'RETURN_APPROVED');
