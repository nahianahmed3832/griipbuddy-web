import { performance } from "node:perf_hooks";
import { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { localDatabase } from "../db/local.ts";
import { CatalogWriteError } from "../staff/operation-error.ts";
import { listConnectedCatalog } from "./connected-listing.ts";
import type { CatalogReadContext } from "./connected-public.ts";

// The public search reader uses these PostgreSQL relations directly.
const searchTables = ["Department", "DepartmentTranslation", "Product", "ProductTranslation", "ProductSecondaryCategory",
  "ProductImage", "ProductOption", "ProductOptionValue", "Variant", "VariantImage", "VariantOptionSelection",
  "VariantCompatibility", "DeviceModel", "DeviceModelAlias", "MarketOffer"] as const;
export const catalogSearchTableCount = searchTables.length;

export async function catalogSearchIndexStatus(db = getDb()) {
  const rows = await db.$queryRaw<{ table: string; indexes: number; usable: number }[]>`
    SELECT c.relname AS "table", COUNT(i.indexrelid)::integer AS indexes,
      COUNT(i.indexrelid) FILTER (WHERE i.indisvalid AND i.indisready AND i.indislive)::integer AS usable
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_index i ON i.indrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname IN (${Prisma.join(searchTables)})
    GROUP BY c.relname`;
  const byTable = new Map(rows.map(row => [row.table, row]));
  return searchTables.map(table => {
    const row = byTable.get(table);
    const state = !row ? "missing" : row.indexes > 0 && row.indexes === row.usable ? "ready" : "review";
    return { table, indexes: row?.indexes ?? 0, usable: row?.usable ?? 0, state };
  });
}

export async function rebuildCatalogSearchIndexes(guard: (tx: Prisma.TransactionClient) => Promise<void> = async () => {}) {
  if (localDatabase() !== "griipbuddy_test") {
    throw new CatalogWriteError("forbidden", "Index rebuild requires the disposable loopback GriipBuddy test database.");
  }
  await getDb().$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(289561, 11) AS acquired`;
    if (!lock?.acquired) throw new CatalogWriteError("conflict", "Catalog index maintenance is already running.");
    await guard(tx);
    for (const table of searchTables) {
      const relation = Prisma.raw(`public."${table}"`);
      await tx.$executeRaw`REINDEX TABLE ${relation}`;
      await tx.$executeRaw`ANALYZE ${relation}`;
    }
  }, { timeout: 90_000 });
}

export async function reconcileCatalogSearch(db: ReturnType<typeof getDb>, context: CatalogReadContext, category?: string) {
  const start = performance.now();
  const params = new URLSearchParams({ limit: "24" });
  if (category) params.set("category", category);
  const page = await listConnectedCatalog(params, context, db);
  const grouped = page.items.every(({ representative, matchingVariantIds }) => matchingVariantIds.includes(representative.variantId) &&
    representative.offer.marketId === page.marketId && representative.offer.currency === page.currency) &&
    new Set(page.items.map(item => item.id)).size === page.items.length;
  const sample = page.items.find(item => item.representative.sku.length <= 120);
  let exactProbe: "matched" | "no_public_variant" | "mismatch" = "no_public_variant";
  if (sample) {
    params.set("q", sample.representative.sku);
    const lookup = await listConnectedCatalog(params, context, db, undefined, { browsePage: 1, search: true });
    const exact = lookup.items.find(item => item.id === sample.id);
    exactProbe = exact?.matchedVariantId === sample.representative.variantId &&
      exact?.representative.offer.id === sample.representative.offer.id ? "matched" : "mismatch";
  }
  return { ...context, categoryId: page.categoryId, publicParents: page.total, checkedCards: page.items.length,
    exactProbe, status: grouped && exactProbe !== "mismatch" ? "ok" as const : "review" as const,
    durationMs: Math.round(performance.now() - start) };
}
