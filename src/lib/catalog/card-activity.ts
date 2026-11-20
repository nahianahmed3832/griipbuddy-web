import { Prisma } from "../../generated/prisma/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { hybridDemoMode } from "../release-config.ts";

export type CardActivity = { recentUnits: number; demoUnits?: number; rating?: { average: number; count: number } };

export async function cardActivity(marketId: MarketId, productIds: readonly string[]): Promise<Record<string, CardActivity>> {
  const ids = [...new Set(productIds)];
  if (!ids.length) return {};

  const db = getDb();
  const demo = hybridDemoMode();
  const since = new Date(Date.now() - 30 * 86400 * 1000);
  const [sales, reviews] = await Promise.all([
    db.$queryRaw<{ id: string; total: bigint | null; sample: bigint | null }[]>`
      SELECT v."productId" AS id,
             SUM(i.quantity) FILTER (WHERE o."measurementTest" = false) AS total,
             SUM(i.quantity) FILTER (WHERE o."measurementTest" = true) AS sample
        FROM "OrderItem" i
        JOIN "Variant" v ON v.id = i."variantId"
        JOIN "Order" o ON o.id = i."orderId"
        JOIN "Payment" p ON p."orderId" = o.id
        WHERE v."productId" IN (${Prisma.join(ids)})
          AND o."marketId"::text = ${marketId}
          AND (o."measurementTest" = false OR (${demo} AND o."measurementTest" = true))
          AND o.status = 'PLACED'
          AND o."fulfillmentStatus" = 'DELIVERED'
          AND o."createdAt" >= ${since}
          AND p.status IN ('COLLECTED', 'PAID')
        GROUP BY v."productId"
    `,
    db.shopperReview.groupBy({
      by: ["productId"],
      where: { productId: { in: ids }, visible: true },
      _avg: { stars: true },
      _count: { stars: true },
    }),
  ]);

  const activity: Record<string, CardActivity> = Object.fromEntries(
    sales.map(row => [row.id, { recentUnits: Number(row.total), ...(demo && row.sample !== null && { demoUnits: Number(row.sample) }) }]),
  );
  for (const review of reviews) {
    const info = activity[review.productId] ?? { recentUnits: 0 };
    info.rating = { average: review._avg.stars ?? 0, count: review._count.stars };
    activity[review.productId] = info;
  }
  return activity;
}
