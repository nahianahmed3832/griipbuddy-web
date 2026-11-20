import { z } from "zod";
import { defaultMarketId, type MarketId } from "../../config/markets.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";

const dateInput = z.iso.date().refine(day => day >= "1970-01-01");

export type SellerOrderRange = {
  from: string;
  to: string;
  start: Date;
  endExclusive: Date;
  marketId: MarketId;
};

export function sellerOrderRange(from: unknown, to: unknown, now = new Date(), marketId: MarketId = defaultMarketId): SellerOrderRange | null {
  const { timeZone } = marketConfiguration(marketId);
  const today = marketDay(now, timeZone);
  const end = dateInput.safeParse(to === undefined || to === "" ? today : to);
  if (!end.success) return null;
  const defaultStart = shiftCalendarDay(end.data, -29);
  const start = dateInput.safeParse(from === undefined || from === "" ? defaultStart : from);
  if (!start.success || start.data > end.data) return null;
  const startAt = marketDayStart(start.data, timeZone);
  const followingDay = shiftCalendarDay(end.data, 1);
  const endAt = followingDay && marketDayStart(followingDay, timeZone);
  if (!startAt || !endAt) return null;
  return {
    marketId,
    from: start.data,
    to: end.data,
    start: startAt,
    endExclusive: endAt,
  };
}
