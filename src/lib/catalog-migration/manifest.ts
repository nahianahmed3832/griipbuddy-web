import { z } from "zod";
import { categoryManifestInput, productManifestInput } from "./catalog.ts";
import { legacyCategoryInput } from "./category-reconciliation.ts";
import { commerceManifestInput } from "./commerce.ts";
import { migrationIssueInput, migrationVersion } from "./contracts.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const referenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const externalReference = z.strictObject({
  sourceSystem: z.literal("recovered-mongo"),
  entity: z.enum(["product", "variant"]),
  sourceId: referenceId,
  targetId: referenceId,
  evidence: referenceId,
});

const batchInput = z.strictObject({
  catalog: productManifestInput,
  commerce: commerceManifestInput,
  legacyReferences: z.array(externalReference).max(300).default([]),
});

export const migrationManifestInput = z.strictObject({
  version: z.literal(migrationVersion),
  sourceKind: z.enum(["representative-fixtures", "sanitized-copy"]),
  categories: z.array(categoryManifestInput).max(2000),
  legacyCategories: z.array(legacyCategoryInput).min(1).max(2000).optional(),
  batches: z.array(batchInput).max(2000),
}).refine(({ categories, legacyCategories, batches }) => Boolean(categories.length || legacyCategories?.length || batches.length),
  "Review at least one category or product batch.");
export type MigrationManifest = z.infer<typeof migrationManifestInput>;
export type ProductMigrationBatch = z.infer<typeof batchInput>;

export const reviewBatchInput = z.strictObject({
  key: z.string(),
  sourceDigest: digest,
  targetVariantIds: z.array(z.string()),
  historyDigest: digest.nullable(),
  historyCounts: z.record(z.string(), z.number().int().nonnegative()),
  sourceProducts: z.number().int().nonnegative(),
  targetProducts: z.number().int().nonnegative(),
  issues: z.array(migrationIssueInput),
  reconciliation: z.json(),
});
export type ReviewBatch = z.infer<typeof reviewBatchInput>;

export const reviewedPlanInput = z.strictObject({
  manifest: migrationManifestInput,
  target: z.string(),
  batches: z.array(reviewBatchInput).min(1),
  issues: z.array(migrationIssueInput),
  digest,
});
export type ReviewedPlan = z.infer<typeof reviewedPlanInput>;
