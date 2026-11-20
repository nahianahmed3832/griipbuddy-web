import { cache } from "react";
import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";

const day = 86_400_000;

export const homepageDemand = cache(async (marketId: MarketId, at: Date) => {
  const lastWeek = new Date(+at - 7 * day);
  const db = getDb();
  const [sales, attention] = await Promise.all([
    db.$queryRaw<{ id: string }[]>`
      SELECT v."productId" AS id
      FROM "OrderItem" i
      JOIN "Variant" v ON v.id = i."variantId"
      JOIN "Order" o ON o.id = i."orderId"
      JOIN "Payment" p ON p."orderId" = o.id
      WHERE o."marketId" = ${marketId}::"MarketCode" AND o."measurementTest" = false AND o.status = 'PLACED'
        AND o."fulfillmentStatus" = 'DELIVERED' AND p.status IN ('COLLECTED', 'PAID')
        AND o."createdAt" >= ${new Date(+at - 30 * day)} AND o."createdAt" <= ${at}
      GROUP BY v."productId"
      HAVING COUNT(DISTINCT o.id) >= 3
      ORDER BY SUM(i.quantity) DESC, COUNT(DISTINCT o.id) DESC, v."productId"
      LIMIT 100
    `,
    db.$queryRaw<{ id: string }[]>`
      WITH attention AS (
        SELECT e."productId" AS id,
          COUNT(DISTINCT (e."journeyId", e."sessionId")) FILTER (WHERE e.at >= ${lastWeek}) AS current,
          COUNT(DISTINCT (e."journeyId", e."sessionId")) FILTER (WHERE e.at < ${lastWeek}) AS previous
        FROM "MeasurementEvent" e
        JOIN "MeasurementJourney" j ON j.id = e."journeyId"
        WHERE e."marketId" = ${marketId}::"MarketCode" AND e.kind = 'PRODUCT_VIEW' AND j.test = false
          AND e.at >= ${new Date(+at - 14 * day)} AND e.at <= ${at}
          AND e."sessionId" IS NOT NULL AND e."productId" IS NOT NULL
        GROUP BY e."productId"
      )
      SELECT id FROM attention
      WHERE current >= 5 AND current >= previous + 3 AND current * 2 >= previous * 3
      ORDER BY current - previous DESC, current DESC, id
      LIMIT 100
    `,
  ]);
  return { bestsellers: sales.map(row => row.id), trending: attention.map(row => row.id) };
});
