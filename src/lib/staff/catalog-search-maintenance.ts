import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { CatalogApiError } from "../catalog/connected-public.ts";
import { catalogSearchIndexStatus, catalogSearchTableCount, rebuildCatalogSearchIndexes, reconcileCatalogSearch } from "../catalog/search-maintenance.ts";
import { getDb } from "../db/client.ts";
import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";
import { marketConfiguration } from "../market-config.ts";
import { authorize } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";

const target = "catalog-search-index-maintenance";
const action = "MERCHANDISING_REVIEW";
type SearchOperation = "reconcile" | "rebuild";

function requireIsolatedSearchMaintenance() {
  if (!localDatabase() && !developmentAcceptanceDatabase()) {
    throw new CatalogWriteError("forbidden", "Search maintenance requires an isolated GriipBuddy workspace.");
  }
}

export async function readStaffCatalogSearchMaintenance(actorId: string, marketId: MarketId) {
  requireIsolatedSearchMaintenance();
  const db = getDb();
  await authorize(db, actorId, true);
  const [tables, history] = await Promise.all([
    catalogSearchIndexStatus(db),
    db.auditEvent.findMany({ where: { action, target, OR: [
      { changes: { path: ["operation"], equals: "rebuild" } },
      { changes: { path: ["marketId"], equals: marketId } },
    ] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 15,
    select: { id: true, createdAt: true, actor: { select: { name: true } }, changes: true } }),
  ]);
  const market = marketConfiguration(marketId);
  return { marketId, locale: market.defaultLocale, marketName: market.name, tables, history,
    canRebuild: localDatabase() === "griipbuddy_test" };
}

export async function runStaffCatalogSearchMaintenance(actorId: string, marketId: MarketId, operation: SearchOperation, raw: unknown) {
  requireIsolatedSearchMaintenance();
  catalogWriteInput(z.strictObject({}), raw);
  const db = getDb();
  await authorize(db, actorId, true);
  if (operation === "rebuild") {
    await rebuildCatalogSearchIndexes(async tx => {
      await tx.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actorId} FOR SHARE`;
      await authorize(tx, actorId, true);
      // A failed rebuild rolls back this record with the index changes.
      await tx.auditEvent.create({ data: { action, target, actorId,
        changes: { operation, marketId, rebuiltTables: catalogSearchTableCount } } });
    });
    return { operation, rebuiltTables: catalogSearchTableCount };
  }

  const { defaultLocale: locale } = marketConfiguration(marketId);
  let scope;
  try {
    scope = await reconcileCatalogSearch(db, { marketId, locale });
  } catch (error) {
    if (error instanceof CatalogApiError && error.status < 500) throw new CatalogWriteError("invalid_input", error.message);
    throw error;
  }
  await db.$transaction(async tx => {
    await authorize(tx, actorId, true);
    await tx.auditEvent.create({ data: { action, target, actorId, changes: { operation, ...scope } } });
  });
  return { operation, ...scope };
}
