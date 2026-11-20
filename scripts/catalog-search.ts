import "./load-env.ts";
import { parseArgs } from "node:util";
import { marketIds } from "../src/config/markets.ts";
import { CatalogApiError } from "../src/lib/catalog/connected-public.ts";
import { catalogSearchTableCount, rebuildCatalogSearchIndexes, reconcileCatalogSearch } from "../src/lib/catalog/search-maintenance.ts";
import { getDb } from "../src/lib/db/client.ts";
import { requireLocalDatabase } from "../src/lib/db/local.ts";
import { isMarketSelectable, marketConfiguration, marketLanguage } from "../src/lib/market-config.ts";

const usage = "Use npm run catalog:search -- reconcile|rebuild [--market bd|us] [--locale TAG] [--category ID].";

let db: ReturnType<typeof getDb> | undefined;
let phase = "arguments";
try {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { market: { type: "string" }, locale: { type: "string" }, category: { type: "string" } } });
  const [mode] = positionals;
  if (positionals.length !== 1 || (mode !== "reconcile" && mode !== "rebuild") ||
      (values.market !== undefined && !isMarketSelectable(values.market)) || (values.locale !== undefined && !values.market)) throw new Error(usage);
  const contexts = marketIds.filter(id => isMarketSelectable(id) && (!values.market || values.market === id)).map(marketId => {
    const market = marketConfiguration(marketId);
    const locale = values.locale === undefined ? market.defaultLocale : marketLanguage(market, values.locale);
    if (!locale) throw new Error("Choose a supported locale for the requested market.");
    return { marketId, locale };
  });
  requireLocalDatabase(mode === "rebuild" ? "griipbuddy_test" : undefined);
  db = getDb();
  if (mode === "rebuild") {
    phase = "rebuild";
    await rebuildCatalogSearchIndexes();
  }
  phase = "reconciliation";
  const scopes = [];
  for (const context of contexts) scopes.push(await reconcileCatalogSearch(db, context, values.category));
  process.stdout.write(`${JSON.stringify({ mode, checkedAt: new Date().toISOString(),
    ...(mode === "rebuild" && { rebuiltTables: catalogSearchTableCount }), scopes }, null, 2)}\n`);
  if (scopes.some(scope => scope.status !== "ok")) process.exitCode = 2;
} catch (error) {
  const code = error instanceof CatalogApiError ? error.code : phase;
  const message = error instanceof CatalogApiError || phase === "arguments" && error instanceof Error ? error.message
    : "Catalog search maintenance stopped. Check local database access and schema, then retry.";
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}
