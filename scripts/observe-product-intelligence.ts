import "./load-env.ts";
import { isMarketId, marketIds } from "../src/config/markets.ts";
import { getDb } from "../src/lib/db/client.ts";
import { marketConfiguration } from "../src/lib/market-config.ts";
import { observeProductIntelligence } from "../src/lib/intelligence/inventory-observations.ts";

const requested = process.argv.slice(2);
if (requested.length > 1 || requested.length === 1 && !isMarketId(requested[0])) throw new Error("Pass one configured market ID or no arguments.");
const active = marketIds.filter(id => {
  const stage = marketConfiguration(id).status;
  return stage === "staging" || stage === "active";
});
const selected = requested.length ? active.filter(id => id === requested[0]) : active;
try {
  if (!selected.length) throw new Error("No selected market is configured for operation.");
  for (const market of selected) console.log(JSON.stringify(await observeProductIntelligence(market)));
} finally {
  await getDb().$disconnect();
}
