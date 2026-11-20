BEGIN;

-- CreateEnum
CREATE TYPE "CatalogMigrationStatus" AS ENUM ('RUNNING', 'PAUSED', 'FAILED', 'COMPLETED');

-- CreateTable
CREATE TABLE "CatalogMigrationRun" (
    "id" CHAR(64) NOT NULL,
    "version" TEXT NOT NULL,
    "status" "CatalogMigrationStatus" NOT NULL DEFAULT 'RUNNING',
    "expectedBatches" INTEGER NOT NULL,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogMigrationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogMigrationCheckpoint" (
    "runId" CHAR(64) NOT NULL,
    "batchKey" TEXT NOT NULL,
    "sourceDigest" CHAR(64) NOT NULL,
    "targetDigest" CHAR(64) NOT NULL,
    "report" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogMigrationCheckpoint_pkey" PRIMARY KEY ("runId","batchKey")
);

-- CreateTable
CREATE TABLE "CatalogMigrationMapping" (
    "sourceSystem" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "runId" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogMigrationMapping_pkey" PRIMARY KEY ("sourceSystem","entity","sourceId")
);

-- CreateTable
CREATE TABLE "CatalogMigrationRedirect" (
    "slug" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,

    CONSTRAINT "CatalogMigrationRedirect_pkey" PRIMARY KEY ("slug")
);

-- CreateIndex
CREATE INDEX "CatalogMigrationMapping_entity_targetId_idx" ON "CatalogMigrationMapping"("entity", "targetId");

-- CreateIndex
CREATE INDEX "CatalogMigrationMapping_runId_idx" ON "CatalogMigrationMapping"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogMigrationRedirect_sourceProductId_key" ON "CatalogMigrationRedirect"("sourceProductId");

-- CreateIndex
CREATE INDEX "CatalogMigrationRedirect_productId_idx" ON "CatalogMigrationRedirect"("productId");

-- AddForeignKey
ALTER TABLE "CatalogMigrationCheckpoint" ADD CONSTRAINT "CatalogMigrationCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CatalogMigrationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogMigrationMapping" ADD CONSTRAINT "CatalogMigrationMapping_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CatalogMigrationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogMigrationRedirect" ADD CONSTRAINT "CatalogMigrationRedirect_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogMigrationRedirect" ADD CONSTRAINT "CatalogMigrationRedirect_sourceProductId_fkey" FOREIGN KEY ("sourceProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CatalogMigrationRun"
  ADD CONSTRAINT "CatalogMigrationRun_batch_count_check" CHECK ("expectedBatches" > 0);

ALTER TABLE "CatalogMigrationRedirect"
  ADD CONSTRAINT "CatalogMigrationRedirect_target_check" CHECK ("sourceProductId" <> "productId");

COMMIT;
