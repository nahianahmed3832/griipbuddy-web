import "./load-env.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { getDb } from "../src/lib/db/client.ts";
import { applyCatalogMigration, catalogMigrationTarget, CatalogMigrationError, dryRunCatalogMigration } from "../src/lib/catalog-migration/engine.ts";
import { writeCatalogMigrationReports } from "../src/lib/catalog-migration/report.ts";

let prefix: string | undefined;
let opened = false;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    manifest: { type: "string" }, plan: { type: "string" }, report: { type: "string" }, "max-batches": { type: "string" },
  } });
  const [mode] = positionals;
  const source = mode === "dry-run" ? values.manifest : values.plan;
  if (positionals.length !== 1 || !source || !values.report ||
      (mode === "dry-run" ? values.plan || values["max-batches"] : mode !== "apply" || values.manifest)) {
    throw new CatalogMigrationError("usage", "Use dry-run --manifest FILE --report PREFIX or apply --plan FILE --report PREFIX [--max-batches N].");
  }
  if ([`${values.report}.json`, `${values.report}.md`].some(path => resolve(path) === resolve(source))) {
    throw new CatalogMigrationError("report-overwrites-input", "Choose a separate report prefix to retain the original input.");
  }
  prefix = values.report;
  catalogMigrationTarget();
  const input = await readFile(source, "utf8").catch(() => {
    throw new CatalogMigrationError("input-unreadable", "The manifest or reviewed plan file could not be read.");
  });
  const raw = JSON.parse(input) as unknown;
  opened = true;
  const report = mode === "dry-run" ? await dryRunCatalogMigration(raw) :
    await applyCatalogMigration(raw, values["max-batches"] === undefined ? undefined : Number(values["max-batches"]));
  await writeCatalogMigrationReports(prefix, report);
  if ("digest" in report && (report.issues.length || report.batches.some(batch => batch.issues.length))) process.exitCode = 2;
  process.stdout.write(`Wrote ${prefix}.json and ${prefix}.md\n`);
} catch (error) {
  let failure = { code: "migration-failed", message: "Migration stopped. Check the database and recorded checkpoints before retrying.", issues: [] as CatalogMigrationError["issues"] };
  if (error instanceof CatalogMigrationError) failure = { code: error.code, message: error.message, issues: error.issues };
  if (error instanceof SyntaxError) failure = { code: "invalid-json", message: "The migration input must contain valid JSON.", issues: [] };
  if (error instanceof ZodError) failure = { code: "invalid-input", message: "The migration input does not match the versioned contract.",
    issues: error.issues.map(issue => ({ code: issue.code, reference: issue.path.join(".") || "input", message: "Check this field against the manifest or plan contract." })) };
  if (prefix) {
    try { await writeCatalogMigrationReports(prefix, { status: "BLOCKED", ...failure }); }
    catch { process.stderr.write("Could not write the migration report.\n"); }
  }
  process.stderr.write(`${failure.message}\n`);
  process.exitCode = 1;
} finally {
  if (opened) await getDb().$disconnect();
}
