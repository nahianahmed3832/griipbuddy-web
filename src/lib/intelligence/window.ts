import { marketConfiguration } from "../market-config.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import type { IntelligenceInput, IntelligenceWindow } from "./types.ts";

export const maxIntelligenceDays = 180;
export const intelligenceBatch = 50_000;

export function intelligenceWindow(input: IntelligenceInput, days = 28): IntelligenceWindow {
  const now = input.now ?? new Date();
  const { timeZone } = marketConfiguration(input.marketId);
  const today = marketDay(now, timeZone);
  const oldest = shiftCalendarDay(today, -maxIntelligenceDays)!;
  const yesterday = shiftCalendarDay(today, -1)!;
  const to = input.to && input.to >= oldest && input.to <= yesterday && marketDayStart(input.to, timeZone) ? input.to : yesterday;
  const firstDefault = shiftCalendarDay(to, 1 - days)!;
  const from = input.from && input.from >= oldest && input.from <= to && marketDayStart(input.from, timeZone)
    ? input.from : firstDefault > oldest ? firstDefault : oldest;
  return { from, to, fromAt: marketDayStart(from, timeZone)!, until: marketDayStart(shiftCalendarDay(to, 1)!, timeZone)!, timeZone };
}

export function windowDays(window: Pick<IntelligenceWindow, "from" | "to">) {
  const days: string[] = [];
  for (let day = window.from; day <= window.to; day = shiftCalendarDay(day, 1)!) days.push(day);
  return days;
}
