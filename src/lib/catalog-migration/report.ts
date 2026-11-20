import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { inspectCommerce } from "./commerce.ts";
import type { MigrationIssue } from "./contracts.ts";
import type { applyCatalogMigration } from "./engine.ts";
import type { ReviewedPlan } from "./manifest.ts";

type ApplyReport = Awaited<ReturnType<typeof applyCatalogMigration>>;
type FailureReport = { status: "BLOCKED"; code: string; message: string; issues: MigrationIssue[] };
export type MigrationReport = ReviewedPlan | ApplyReport | FailureReport;

const cell = (value: unknown) => String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
const quantity = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

function issueLines(issues: MigrationIssue[]) {
  return issues.map(issue => `- **${cell(issue.code)}** (${cell(issue.reference)}) ${cell(issue.message)}`);
}

function taxonomyDetails(reconciliation: unknown) {
  const taxonomy = reconciliation as { recoveredCategories?: number; businessCodes?: number; newAliases?: number; newTranslations?: number } | null;
  if (!taxonomy?.recoveredCategories) return [];
  return ["", "### Reviewed legacy categories", "",
    `Reviewed ${quantity(taxonomy.recoveredCategories, "source category", "source categories")} and ${quantity(taxonomy.businessCodes ?? 0, "business code")}.`,
    `Additive presentation changes include ${quantity(taxonomy.newAliases ?? 0, "URL alias", "URL aliases")} and ${quantity(taxonomy.newTranslations ?? 0, "translation")}.`];
}

function reviewDetails(batches: ReviewedPlan["batches"]) {
  type Reconciliation = Awaited<ReturnType<typeof inspectCommerce>>["reconciliation"];
  return batches.flatMap(({ key, reconciliation }) => {
    if (key === "taxonomy") return taxonomyDetails(reconciliation);
    const { prices, stock, outstanding } = reconciliation as Partial<Reconciliation>;
    if (!prices?.length && !stock?.length && !outstanding?.some(row => row.reserved || row.allocated)) return [];
    return ["", `### ${cell(key)}`,
      ...(prices?.length ? ["", "| Market | Currency | Offers | Regular minor units | Configured sale minor units |", "| --- | --- | ---: | ---: | ---: |",
        ...prices.map(row => `| ${row.marketId} | ${row.currency} | ${row.offers} | ${row.regularMinor} | ${row.configuredSaleMinor} |`)] : []),
      ...(stock?.length ? ["", "| Variant | Owner | Warehouse | Legacy available observations | Reviewed on hand | Reserved | Allocated | Duplicate projections |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |", ...stock.map(row =>
          `| ${cell(row.variantId)} | ${cell(row.ownerId)} | ${cell(row.locationId)} | ${row.legacyAmounts.join(", ")} | ${row.onHand} | ${row.reserved} | ${row.allocated} | ${row.duplicateRepresentations} |`)] : []),
      ...outstanding?.filter(row => row.reserved || row.allocated).flatMap(row => ["",
        `Legacy records for ${cell(row.variantId)} show ${row.reserved} reserved and ${row.allocated} allocated units.`]) ?? [],
    ];
  });
}

export function migrationMarkdown(report: MigrationReport) {
  if ("digest" in report) {
    const issues = [...report.issues, ...report.batches.flatMap(batch => batch.issues)];
    return [
      "# Catalog migration dry run", "",
      `**${issues.length ? "Blocked" : "Ready for isolated apply"}** · ${report.manifest.sourceKind}`, "",
      `Version \`${report.manifest.version}\` · Plan \`${report.digest}\``, "",
      "| Batch | Source products | Connected parents | Variants | Historical lines | Critical issues |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...report.batches.map(row => `| ${cell(row.key)} | ${row.sourceProducts} | ${row.targetProducts} | ${row.targetVariantIds.length} | ${row.historyCounts.orderItems ?? 0} | ${row.issues.length} |`),
      ...(issues.length ? ["", "## Critical issues", "", ...issueLines(issues)] : []),
      ...reviewDetails(report.batches), "",
    ].join("\n");
  }
  if ("code" in report) return ["# Catalog migration blocked", "", report.message, "", ...issueLines(report.issues), ""].join("\n");
  const rows = report.batches;
  const details: string[] = [];
  for (const batch of rows) {
    if (batch.key === "taxonomy") details.push(...taxonomyDetails(batch.reconciliation));
    const after = (batch.reconciliation as { after?: {
      offers: { variantId: string; marketId: string; currency: string; amountMinor: number; saleDiscountMinor: number | null }[];
      pools: { variantId: string; ownerId: string; warehouseId: string; onHand: number; reserved: number; allocated: number; available: number }[];
      historyCounts: Record<string, number>;
    } }).after;
    if (!after) continue;
    details.push("", `### ${cell(batch.key)}`, "",
      "| Variant | Market | Currency | Regular minor units | Sale discount minor units |",
      "| --- | --- | --- | ---: | ---: |",
      ...after.offers.map(row => `| ${cell(row.variantId)} | ${row.marketId} | ${row.currency} | ${row.amountMinor} | ${row.saleDiscountMinor ?? ""} |`),
      "", "| Variant | Owner | Warehouse | On hand | Reserved | Allocated | Available |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: |",
      ...after.pools.map(row => `| ${cell(row.variantId)} | ${cell(row.ownerId)} | ${cell(row.warehouseId)} | ${row.onHand} | ${row.reserved} | ${row.allocated} | ${row.available} |`),
      "", `Preserved ${quantity(after.historyCounts.orderItems ?? 0, "purchased line")}, ${quantity(after.historyCounts.parcelItems ?? 0, "parcel line")}, and ${quantity(after.historyCounts.returnLines ?? 0, "return line")}.`);
  }
  return [
    "# Catalog migration reconciliation", "",
    `**${report.status}** · ${report.sourceKind}`, "",
    `Version \`${report.version}\` · Run \`${report.runId}\``, "",
    `Applied ${quantity(report.appliedBatches, "batch", "batches")}, verified ${quantity(report.replayedBatches, "existing checkpoint")}, ${rows.length} of ${report.expectedBatches} complete.`, "",
    "| Batch | Source products | Connected parents | Variants | Identifier mappings |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows.map(row => `| ${cell(row.key)} | ${row.sourceProducts} | ${row.targetProducts} | ${row.variants} | ${row.mappings.length} |`),
    ...details, "",
  ].join("\n");
}

export async function writeCatalogMigrationReports(prefix: string, report: MigrationReport) {
  await mkdir(dirname(prefix), { recursive: true, mode: 0o700 });
  const output = [[`${prefix}.json`, JSON.stringify(report, null, 2) + "\n"], [`${prefix}.md`, migrationMarkdown(report)]] as const;
  for (const [path, content] of output) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
