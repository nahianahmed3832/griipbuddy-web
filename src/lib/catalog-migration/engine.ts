import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import { lockVariantInventory } from "../commerce/location-inventory.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { localDatabase } from "../db/local.ts";
import { lockTaxonomy } from "../staff/taxonomy-write.ts";
import { applyCategories, applyProducts, inspectCategories, inspectProducts, reconcileCatalogProduct } from "./catalog.ts";
import { applyLegacyCategoryPresentation, inspectLegacyCategories } from "./category-reconciliation.ts";
import { applyCommerce, inspectCommerce } from "./commerce.ts";
import { migrationDigest, migrationVersion, nativeSourceSystem, type MigrationIssue, type MigrationMapping } from "./contracts.ts";
import { inspectLegacyHistory } from "./history.ts";
import { migrationManifestInput, reviewBatchInput, reviewedPlanInput, type MigrationManifest, type ProductMigrationBatch, type ReviewedPlan, type ReviewBatch } from "./manifest.ts";
import { categoryTargetDigest, mappingKey, productTargetDigest, readMappings } from "./snapshot.ts";

const taxonomyKey = "taxonomy";
const productKey = (batch: ProductMigrationBatch) => `product:${batch.catalog.targetProductId}`;
const hasTaxonomy = (manifest: MigrationManifest) => Boolean(manifest.categories.length || manifest.legacyCategories?.length);
const transactionOptions = { isolationLevel: "Serializable", maxWait: 10_000, timeout: 90_000 } as const;
type Tx = Prisma.TransactionClient;

export class CatalogMigrationError extends Error {
  constructor(readonly code: string, message: string, readonly issues: MigrationIssue[] = []) {
    super(message);
    this.name = "CatalogMigrationError";
  }
}

export function catalogMigrationTarget() {
  if (localDatabase() !== "griipbuddy_test" || process.env.GRIIP_CATALOG_MIGRATION_ISOLATED !== "1") {
    throw new CatalogMigrationError("isolated-profile-required", "Use COMMERCE_MODE=local, a disposable loopback griipbuddy_test database and GRIIP_CATALOG_MIGRATION_ISOLATED=1.");
  }
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hash) throw new CatalogMigrationError("invalid-target", "Do not include a fragment in the database URL.");
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

async function checkDatabase(db: DbReader) {
  const [current] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (current?.name !== "griipbuddy_test") throw new CatalogMigrationError("target-changed", "The connected database is not the expected isolated target.");
}

async function writeTransaction<T>(db: PrismaClient, work: (tx: Tx) => Promise<T>) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(3100, 10)`;
    await checkDatabase(tx);
    return work(tx);
  }, transactionOptions);
}

function manifestIssues(manifest: MigrationManifest) {
  const issues: MigrationIssue[] = [];
  const owners = new Map<string, string>();
  const targets = new Set<string>();
  const external = new Map<string, string>();
  const warehouseScopes = new Map<string, string>();
  const verifiedVariantIds = new Set<string>();
  const verifiedSkus = new Set<string>();
  for (const batch of manifest.batches) {
    const { targetProductId, sourceProductIds, verifiedSimple } = batch.catalog;
    if (targets.has(targetProductId)) issues.push({
      code: "duplicate-product-batch", reference: targetProductId, message: "The target appears in more than one batch.",
    });
    targets.add(targetProductId);
    if (verifiedSimple) {
      const sku = verifiedSimple.sku.normalize("NFKC").toLowerCase();
      if (verifiedVariantIds.has(verifiedSimple.variantId) || verifiedSkus.has(sku)) issues.push({
        code: "duplicate-verified-variant", reference: targetProductId, message: "A verified simple variant ID or SKU appears in more than one batch.",
      });
      verifiedVariantIds.add(verifiedSimple.variantId);
      verifiedSkus.add(sku);
    }
    for (const id of new Set([targetProductId, ...sourceProductIds])) {
      const prior = owners.get(id);
      if (prior && prior !== targetProductId) issues.push({
        code: "overlapping-product-batches", reference: id, message: "A product cannot participate in more than one group.",
      });
      owners.set(id, targetProductId);
    }
    for (const reference of batch.legacyReferences) {
      const key = migrationDigest(mappingKey(reference));
      if (external.has(key) && external.get(key) !== reference.targetId) issues.push({
        code: "conflicting-external-mapping", reference: reference.sourceId, message: "The external identifier targets multiple records.",
      });
      external.set(key, reference.targetId);
    }
    for (const pool of batch.commerce.inventory) {
      const routeSet = migrationDigest(pool.routes.map(route => ({
        marketId: route.marketId, priority: route.priority ?? 100, districts: [...(route.districts ?? [])].sort(),
        methods: [...(route.methods ?? [])].sort(),
      })).sort((left, right) => left.marketId.localeCompare(right.marketId, "en")));
      if (warehouseScopes.has(pool.locationId) && warehouseScopes.get(pool.locationId) !== routeSet) issues.push({
        code: "conflicting-warehouse-route", reference: pool.locationId, message: "Every pool at this warehouse needs the same complete market route set.",
      });
      warehouseScopes.set(pool.locationId, routeSet);
    }
  }
  return issues;
}

function externalMappings(batch: ProductMigrationBatch) {
  return batch.legacyReferences.map(({ sourceSystem, entity, sourceId, targetId }) => ({ sourceSystem, entity, sourceId, targetId }));
}

async function mappingIssues(db: DbReader, proposed: MigrationMapping[]) {
  const expected = new Map(proposed.map(row => [migrationDigest(mappingKey(row)), row.targetId]));
  return (await readMappings(db, proposed)).flatMap(row =>
    expected.get(migrationDigest(mappingKey(row))) !== row.targetId ? [{
      code: "conflicting-mapping", reference: row.sourceId, message: "This legacy identifier is already mapped to a different target.",
    }] : [],
  );
}

function nativeMapping(entity: string, sourceId: string, targetId = sourceId): MigrationMapping {
  return { sourceSystem: nativeSourceSystem, entity, sourceId, targetId };
}

async function inspectTaxonomy(db: DbReader, manifest: MigrationManifest) {
  const catalog = await inspectCategories(db, manifest.categories);
  const legacy = manifest.legacyCategories?.length
    ? await inspectLegacyCategories(db, manifest.legacyCategories, manifest.categories) : null;
  const issues = [...catalog.issues, ...legacy?.issues ?? [], ...await mappingIssues(db, [
    ...manifest.categories.map(({ id }) => nativeMapping("category", id)), ...legacy?.mappings ?? [],
  ])];
  const review: ReviewBatch = {
    key: taxonomyKey, sourceDigest: migrationDigest(legacy ? [catalog.source, legacy.source] : catalog.source),
    targetVariantIds: [], historyDigest: null, historyCounts: {}, sourceProducts: 0, targetProducts: 0, issues,
    reconciliation: { categories: manifest.categories.length, ...(legacy && {
      recoveredCategories: manifest.legacyCategories!.length, businessCodes: legacy.mappings.length - manifest.legacyCategories!.length,
      newAliases: legacy.aliases.length, newTranslations: legacy.translations.length,
    }) },
  };
  return { catalog, legacy, review };
}

async function inspectBatch(db: DbReader, batch: ProductMigrationBatch, manifest: MigrationManifest) {
  const catalog = await inspectProducts(db, batch.catalog, manifest.categories);
  const commerce = await inspectCommerce(db, catalog.sourceVariantIds, batch.commerce);
  const history = await inspectLegacyHistory(db, catalog.sourceVariantIds, batch.catalog.sourceProductIds);
  const external = externalMappings(batch);
  const issues = [...catalog.issues, ...commerce.issues, ...history.issues, ...await mappingIssues(db, [
    ...catalog.mappings, ...commerce.mappings, ...external,
  ])];
  for (const row of external) {
    if (row.entity === "product" ? row.targetId !== batch.catalog.targetProductId : !catalog.targetVariantIds.includes(row.targetId)) {
      issues.push({ code: "external-reference-out-of-scope", reference: row.sourceId, message: "The reviewed target is outside this product batch." });
    }
  }
  const review = reviewBatchInput.parse({
    key: productKey(batch), sourceDigest: migrationDigest([catalog.source, commerce.source, history.digest]),
    targetVariantIds: catalog.targetVariantIds, historyDigest: history.digest, historyCounts: history.counts,
    sourceProducts: catalog.source.products.length, targetProducts: catalog.target ? 1 : 0,
    issues, reconciliation: commerce.reconciliation,
  });
  return { catalog, commerce, review };
}

export async function dryRunCatalogMigration(raw: unknown) {
  const target = catalogMigrationTarget();
  const manifest = migrationManifestInput.parse(raw);
  const db = getDb();
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await checkDatabase(tx);
    const batches: ReviewBatch[] = [];
    if (hasTaxonomy(manifest)) batches.push((await inspectTaxonomy(tx, manifest)).review);
    for (const batch of manifest.batches) batches.push((await inspectBatch(tx, batch, manifest)).review);
    const body = { target, manifest, issues: manifestIssues(manifest), batches };
    return { ...body, digest: migrationDigest(body) } satisfies ReviewedPlan;
  }, { ...transactionOptions, isolationLevel: "RepeatableRead" });
}

function requireSameSource(planned: ReviewBatch, observed: ReviewBatch) {
  if (observed.sourceDigest !== planned.sourceDigest || observed.issues.length) {
    throw new CatalogMigrationError("source-changed", `Source data changed in ${planned.key}. Review a fresh dry run before applying any new batch.`, observed.issues);
  }
}

async function recordMappings(tx: Tx, runId: string, proposed: MigrationMapping[]) {
  const distinct = new Map<string, MigrationMapping>();
  for (const row of proposed) {
    const key = migrationDigest(mappingKey(row));
    if (distinct.has(key) && distinct.get(key)?.targetId !== row.targetId) {
      throw new CatalogMigrationError("conflicting-mapping", "The batch maps a legacy reference to multiple targets.");
    }
    distinct.set(key, row);
  }
  const mappings = [...distinct.values()];
  const issues = await mappingIssues(tx, mappings);
  if (issues.length) throw new CatalogMigrationError("conflicting-mapping", "An existing mapping belongs to a different target.", issues);
  if (mappings.length) await tx.catalogMigrationMapping.createMany({ data: mappings.map(row => ({ ...row, runId })), skipDuplicates: true });
  return mappings;
}

async function reconcileTarget(tx: Tx, batch: ProductMigrationBatch, review: ReviewBatch) {
  const { targetProductId, sourceProductIds, primaryCategoryId } = batch.catalog;
  const product = await tx.product.findUnique({
    where: { id: targetProductId }, select: { foundation: true, departmentId: true, variants: { orderBy: { id: "asc" }, select: { id: true } } },
  });
  if (!product?.foundation || product.departmentId !== primaryCategoryId ||
      migrationDigest(product.variants.map(row => row.id).sort()) !== migrationDigest([...review.targetVariantIds].sort())) {
    throw new CatalogMigrationError("product-reconciliation", "The target product, category or variant set disagrees with the reviewed batch.");
  }
  const history = await inspectLegacyHistory(tx, review.targetVariantIds, sourceProductIds);
  if (history.digest !== review.historyDigest || history.issues.length) {
    throw new CatalogMigrationError("history-reconciliation", "Historical purchases or integration references changed. The batch was rolled back.", history.issues);
  }
  const offers = [];
  for (const expected of batch.commerce.offers) {
    const actual = await tx.marketOffer.findUnique({
      where: { variantId_marketId: { variantId: expected.variantId, marketId: expected.marketId } }, include: { identity: true },
    });
    if (!actual?.identity || actual.identity.sellerId !== expected.sellerId || actual.currency !== expected.currency || actual.amountMinor !== expected.amountMinor) {
      throw new CatalogMigrationError("offer-reconciliation", "An exact market price or seller failed verification. The batch was rolled back.");
    }
    offers.push({ variantId: actual.variantId, offerId: actual.offerId, marketId: actual.marketId,
      currency: actual.currency, amountMinor: actual.amountMinor, saleDiscountMinor: actual.discountMinor,
      publication: actual.publication, eligible: actual.eligible });
  }
  const pools = [];
  for (const expected of batch.commerce.inventory) {
    const actual = await tx.inventoryPool.findUnique({
      where: { variantId_ownerId_locationId: { variantId: expected.variantId, ownerId: expected.ownerId, locationId: expected.locationId } },
      include: { movements: true, _count: { select: { allocations: true } } },
    });
    const opening = actual?.movements.reduce((total, movement) => total + movement.quantity, 0);
    if (!actual || actual.onHand !== expected.onHand || actual.reserved !== expected.reserved || actual._count.allocations ||
        opening !== expected.onHand || actual.movements.length !== Number(expected.onHand > 0)) {
      throw new CatalogMigrationError("inventory-reconciliation", "An opening stock balance, allocation or movement failed verification. The batch was rolled back.");
    }
    pools.push({ id: actual.id, variantId: actual.variantId, ownerId: actual.ownerId, warehouseId: actual.locationId,
      onHand: actual.onHand, reserved: actual.reserved, allocated: actual._count.allocations, available: actual.onHand - actual.reserved,
      openingUnits: opening });
  }
  return { offers, pools, historyCounts: history.counts };
}

type CheckpointReport = {
  key: string;
  sourceProducts: number;
  targetProducts: number;
  variants: number;
  mappings: MigrationMapping[];
  reconciliation: Prisma.InputJsonValue;
};

function targetDigest(db: DbReader, plan: ReviewedPlan, review: ReviewBatch, mappings: MigrationMapping[]) {
  const batch = plan.manifest.batches.find(row => productKey(row) === review.key);
  return batch ? productTargetDigest(db, batch, review, mappings)
    : categoryTargetDigest(db, plan.manifest.categories, mappings, plan.manifest.legacyCategories);
}

async function verifyCheckpoint(db: DbReader, plan: ReviewedPlan, review: ReviewBatch, checkpoint: {
  sourceDigest: string; targetDigest: string; report: Prisma.JsonValue;
}) {
  const report = checkpoint.report as unknown as CheckpointReport;
  if (checkpoint.sourceDigest !== review.sourceDigest || await targetDigest(db, plan, review, report.mappings) !== checkpoint.targetDigest) {
    throw new CatalogMigrationError("target-changed", `Completed batch ${review.key} has changed since apply. Reconcile it without replaying or overwriting later activity.`);
  }
}

async function applyBatch(tx: Tx, plan: ReviewedPlan, review: ReviewBatch) {
  const batch = plan.manifest.batches.find(row => productKey(row) === review.key);
  let mappings: MigrationMapping[];
  let reconciliation: Prisma.InputJsonValue;
  if (batch) {
    await lockVariantInventory(tx, review.targetVariantIds);
    const observed = await inspectBatch(tx, batch, plan.manifest);
    requireSameSource(review, observed.review);
    mappings = await recordMappings(tx, plan.digest, [
      ...await applyProducts(tx, observed.catalog), ...await applyCommerce(tx, observed.commerce), ...externalMappings(batch),
    ]);
    reconciliation = {
      before: review.reconciliation, catalog: await reconcileCatalogProduct(tx, observed.catalog), after: await reconcileTarget(tx, batch, review),
    };
  } else {
    await lockTaxonomy(tx);
    const observed = await inspectTaxonomy(tx, plan.manifest);
    requireSameSource(review, observed.review);
    const native = await applyCategories(tx, observed.catalog);
    if (observed.legacy) await applyLegacyCategoryPresentation(tx, observed.legacy);
    mappings = await recordMappings(tx, plan.digest, [...native, ...observed.legacy?.mappings ?? []]);
    reconciliation = review.reconciliation as Prisma.InputJsonValue;
  }
  const report: CheckpointReport = { key: review.key, sourceProducts: review.sourceProducts, targetProducts: review.targetProducts,
    variants: review.targetVariantIds.length, mappings, reconciliation };
  await tx.catalogMigrationCheckpoint.create({
    data: { runId: plan.digest, batchKey: review.key, sourceDigest: review.sourceDigest,
      targetDigest: await targetDigest(tx, plan, review, mappings), report },
  });
}

function failuresOf(plan: ReviewedPlan) {
  return [...plan.issues, ...plan.batches.flatMap(batch => batch.issues)];
}

export async function applyCatalogMigration(raw: unknown, maxBatches = Number.MAX_SAFE_INTEGER) {
  const target = catalogMigrationTarget();
  const plan = reviewedPlanInput.parse(raw);
  const { digest, ...body } = plan;
  if (migrationDigest(body) !== digest || target !== plan.target) {
    throw new CatalogMigrationError("plan-mismatch", "The reviewed plan was changed or targets a different isolated database.");
  }
  const batchKeys = [...(hasTaxonomy(plan.manifest) ? [taxonomyKey] : []), ...plan.manifest.batches.map(productKey)];
  if (migrationDigest(batchKeys) !== migrationDigest(plan.batches.map(batch => batch.key))) {
    throw new CatalogMigrationError("invalid-plan-batches", "The plan does not contain every reviewed batch.");
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) throw new CatalogMigrationError("invalid-batch-limit", "Choose a positive maximum batch count.");
  const issues = failuresOf(plan);
  if (issues.length) throw new CatalogMigrationError("unresolved-conflicts", "Resolve critical conflicts before applying the plan.", issues);
  const db = getDb();
  const existingCount = await writeTransaction(db, async tx => {
    const checkpoints = await tx.catalogMigrationCheckpoint.findMany({ where: { runId: digest } });
    const completed = new Map(checkpoints.map(row => [row.batchKey, row]));
    for (const review of plan.batches) {
      const checkpoint = completed.get(review.key);
      if (checkpoint) await verifyCheckpoint(tx, plan, review, checkpoint);
      else {
        const batch = plan.manifest.batches.find(row => productKey(row) === review.key);
        const observed = batch ? await inspectBatch(tx, batch, plan.manifest) : await inspectTaxonomy(tx, plan.manifest);
        requireSameSource(review, observed.review);
      }
    }
    if (completed.size < plan.batches.length) await tx.catalogMigrationRun.upsert({
      where: { id: digest }, create: { id: digest, version: migrationVersion, expectedBatches: plan.batches.length },
      update: { status: "RUNNING", failureCode: null },
    });
    return completed.size;
  });
  let appliedBatches = 0;
  try {
    for (const review of plan.batches) {
      if (appliedBatches >= maxBatches) break;
      appliedBatches += await writeTransaction(db, async tx => {
        const checkpoint = await tx.catalogMigrationCheckpoint.findUnique({ where: { runId_batchKey: { runId: digest, batchKey: review.key } } });
        if (checkpoint) {
          await verifyCheckpoint(tx, plan, review, checkpoint);
          return 0;
        }
        await applyBatch(tx, plan, review);
        return 1;
      });
    }
    const report = await writeTransaction(db, async tx => {
      const reports = await tx.catalogMigrationCheckpoint.findMany({
        where: { runId: digest }, select: { report: true, batchKey: true }, orderBy: { completedAt: "asc" },
      });
      const status = reports.length === plan.batches.length ? "COMPLETED" : "PAUSED";
      await tx.catalogMigrationRun.updateMany({ where: { id: digest, status: { not: status } }, data: { status } });
      return { status, batches: reports.map(row => row.report) as unknown as CheckpointReport[] };
    });
    return { runId: digest, version: migrationVersion, target, sourceKind: plan.manifest.sourceKind,
      appliedBatches, replayedBatches: existingCount, expectedBatches: plan.batches.length, ...report };
  } catch (error) {
    await db.catalogMigrationRun.updateMany({
      where: { id: digest, status: { not: "COMPLETED" } },
      data: { status: "FAILED", failureCode: error instanceof CatalogMigrationError ? error.code : "transaction-failed" },
    });
    throw error;
  }
}
