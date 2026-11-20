import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { isMarketId, marketList, type Currency, type MarketId } from "../src/config/markets.ts";
import { getDb } from "../src/lib/db/client.ts";
import { developmentAcceptanceDatabase } from "../src/lib/db/local.ts";
import { commerceOutcomeSelect, projectCommerceOutcomes } from "../src/lib/measurement/outcomes.ts";

if (!developmentAcceptanceDatabase() || process.argv.length !== 2) {
  throw new Error("Use the dedicated Marketplace development database and supply the fixture ledger on stdin.");
}

const amount = z.int().min(0).max(2_147_483_647).nullable();
const currency = z.custom<Currency>(value => marketList.some(market => market.currency === value));
const ledger = z.strictObject({
  source: z.string().regex(/^fixture:[a-z0-9][a-z0-9-]{2,53}$/),
  orders: z.array(z.strictObject({
    orderId: z.uuid(), marketId: z.custom<MarketId>(isMarketId), currency,
    verifiedThrough: z.iso.datetime({ precision: 3 }),
    revenueBeforeRefundsMinor: amount, refundsMinor: amount, itemCostMinor: amount, packagingMinor: amount,
    outboundMinor: amount, returnMinor: amount, paymentFeesMinor: amount,
  })).min(1).max(200),
});

const chunks: Buffer[] = [];
let bytes = 0;
for await (const part of process.stdin) {
  const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
  bytes += chunk.length;
  if (bytes > 256 * 1024) throw new Error("Development ledger exceeds 256 KiB.");
  chunks.push(chunk);
}
let parsed: unknown;
try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
catch { throw new Error("Expected a JSON development ledger."); }
const input = ledger.safeParse(parsed);
if (!input.success) throw new Error("Invalid development ledger. Supply every component and use null for missing inputs.");

const { source, orders } = input.data;
const orderIds = orders.map(row => row.orderId);
if (new Set(orderIds).size !== orders.length) throw new Error("Duplicate development ledger order ID.");
const db = getDb();
try {
  const now = new Date();
  const result = await db.$transaction(async tx => {
    const saved = await tx.order.findMany({ where: { id: { in: orderIds }, commerceEvidence: "fixture", measurementTest: true },
      select: commerceOutcomeSelect });
    const byId = new Map(saved.map(order => [order.id, order]));
    let created = 0;
    for (const { marketId, ...row } of orders) {
      const order = byId.get(row.orderId);
      if (!order || order.marketId !== marketId || order.currency !== row.currency) {
        throw new Error("Ledger order must match a development fixture in the stated market and currency.");
      }
      const verifiedThrough = new Date(row.verifiedThrough);
      if (verifiedThrough > now || verifiedThrough < order.updatedAt ||
          projectCommerceOutcomes(order, now).some(event => event.at > verifiedThrough)) {
        throw new Error("Ledger verification date must cover the latest recorded order and its outcomes.");
      }
      const evidence = { ...row, verifiedThrough, source };
      if (order.contributionEvidence) {
        if (!isDeepStrictEqual(order.contributionEvidence, evidence)) throw new Error("Conflicting contribution evidence. Reconcile the fixture ledger before retrying.");
      } else {
        await tx.orderContributionEvidence.create({ data: evidence });
        created++;
      }
    }
    return { evidence: "fixture", created, unchanged: orders.length - created };
  }, { isolationLevel: "Serializable", timeout: 15_000 });
  console.log(JSON.stringify(result));
} finally {
  await db.$disconnect();
}
