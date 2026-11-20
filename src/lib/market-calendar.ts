const dayMs = 86_400_000;
const clocks = new Map<string, Intl.DateTimeFormat>();

function clock(timeZone: string) {
  let formatter = clocks.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23",
    });
    clocks.set(timeZone, formatter);
  }
  return formatter;
}

function wallMinute(value: Date, timeZone: string) {
  const fields = Object.fromEntries(clock(timeZone).formatToParts(value).map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

export function marketDay(date: Date, timeZone: string) {
  return wallMinute(date, timeZone).slice(0, 10);
}

export function shiftCalendarDay(day: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const utc = new Date(day + "T00:00:00.000Z");
  if (!Number.isFinite(+utc) || utc.toISOString().slice(0, 10) !== day) return null;
  return new Date(+utc + days * dayMs).toISOString().slice(0, 10);
}

export function marketDayStart(day: string, timeZone: string) {
  if (!shiftCalendarDay(day, 0)) return null;
  const utc = +new Date(day + "T00:00:00.000Z");
  let first = utc - 2 * dayMs;
  let last = utc + 2 * dayMs;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (marketDay(new Date(middle), timeZone) < day) first = middle + 1;
    else last = middle;
  }
  const boundary = new Date(first);
  return marketDay(boundary, timeZone) === day ? boundary : null;
}

export function localMarketTime(value: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) || !shiftCalendarDay(value.slice(0, 10), 0)) return null;
  const desired = +new Date(value + ":00.000Z");
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const time = desired + hours * 3_600_000;
    offsets.add(+new Date(wallMinute(new Date(time), timeZone) + ":00.000Z") - time);
  }
  // DST can make a wall time either nonexistent or occur twice.
  const matches = [...offsets].map(offset => new Date(desired - offset)).filter(date => wallMinute(date, timeZone) === value);
  return matches.length === 1 ? matches[0] : null;
}
