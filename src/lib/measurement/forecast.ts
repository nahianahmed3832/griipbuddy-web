import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import type { DbReader } from "../db/client.ts";
import type { MarketConfiguration } from "../market-config.ts";

const minimumOrders = 20;

export function summarizeForecast(weeks: readonly number[]) {
  const observations = weeks.reduce((sum, count) => sum + count, 0);
  if (weeks.length !== 4 || observations < minimumOrders) return { observations, minimumOrders, forecast: null };
  const mean = observations / weeks.length;
  const holdout = weeks[3];
  const priorMean = (observations - holdout) / 3;
  return {
    observations, minimumOrders,
    forecast: {
      estimate: Math.round(mean),
      observedLow: Math.min(...weeks),
      observedHigh: Math.max(...weeks),
      lastWeekError: Math.round(Math.abs(priorMean - holdout) * 10) / 10,
    },
  };
}

export async function marketOrderForecast(db: DbReader, market: MarketConfiguration, test: boolean, now: Date) {
  const day = marketDay(now, market.timeZone);
  const end = new Date(day + "T00:00:00Z").getUTCDay();
  const daysIntoWeek = (end - market.reportingCalendar.weekStartsOn + 7) % 7;
  const boundaries = [28, 21, 14, 7, 0].map(days =>
    marketDayStart(shiftCalendarDay(day, -daysIntoWeek - days)!, market.timeZone));
  if (boundaries.some(boundary => !boundary)) return summarizeForecast([]);
  const weeks: number[] = [];
  for (const [index, gte] of boundaries.slice(0, -1).entries()) {
    const period = { marketId: market.id, createdAt: { gte: gte!, lt: boundaries[index + 1]! } };
    const native = await db.order.count({ where: { ...period, measurementTest: test } });
    const bridge = await db.bridgeOrder.count({ where: { ...period, evidence: test ? { in: ["fixture", "sandbox"] } : "production" } });
    weeks.push(native + bridge);
  }
  return summarizeForecast(weeks);
}
