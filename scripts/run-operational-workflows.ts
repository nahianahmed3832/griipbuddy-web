import "./load-env.ts";
import { isMarketId, marketIds, type MarketId } from "../src/config/markets.ts";
import { getDb } from "../src/lib/db/client.ts";
import { developmentAcceptanceDatabase, localDatabase, productionDatabase, stagingDatabase } from "../src/lib/db/local.ts";
import { workflowAdapters } from "../src/lib/workflows/adapters.ts";
import { evaluateWorkflowOutcome } from "../src/lib/workflows/outcomes.ts";
import { runDueWorkflowReviews, runNextWorkflow, sweepWorkflowLifecycle } from "../src/lib/workflows/worker.ts";

const args = process.argv.slice(2);
const scope = args.find(arg => arg === "--test" || arg === "--production");
const market = args.find(arg => isMarketId(arg)) as MarketId | undefined;
if (!scope || args.length !== (market ? 2 : 1)) throw new Error("Use --test or --production and optionally select one configured market.");
const test = scope === "--test";
if (test ? localDatabase() !== "griipbuddy_test" && !developmentAcceptanceDatabase() &&
    !(process.env.GRIIP_MARKET_REVIEW_FIXTURES === "1" && stagingDatabase()) : !productionDatabase()) {
  throw new Error("The required operating database and evidence scope do not match.");
}
const marketIdsForJob = market ? [market] : marketIds;
const filters = { marketIds: marketIdsForJob, test };
try {
  await sweepWorkflowLifecycle(filters);
  let attempts = 0;
  for (; attempts < 12; attempts++) {
    if (!await runNextWorkflow({ ...filters, adapters: workflowAdapters, workerId: "scheduled-workflow-runner" })) break;
  }
  const reviews = await runDueWorkflowReviews({ ...filters, evaluator: evaluateWorkflowOutcome, limit: 12 });
  console.log(JSON.stringify({ scope, markets: marketIdsForJob, attempts, reviews }));
} finally {
  await getDb().$disconnect();
}
