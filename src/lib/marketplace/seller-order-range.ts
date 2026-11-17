import { z } from "zod";

const dayMs = 86_400_000;
const bangladeshOffsetMs = 6 * 60 * 60 * 1000;
const dateInput = z.iso.date().refine(day => day >= "1970-01-01");

export type SellerOrderRange = {
  from: string;
  to: string;
  start: Date;
  endExclusive: Date;
};

export function sellerOrderRange(from: unknown, to: unknown, now = new Date()): SellerOrderRange | null {
  const today = new Date(now.valueOf() + bangladeshOffsetMs).toISOString().slice(0, 10);
  const end = dateInput.safeParse(to === undefined || to === "" ? today : to);
  if (!end.success) return null;
  const defaultStart = new Date(Date.parse(`${end.data}T00:00:00Z`) - 29 * dayMs).toISOString().slice(0, 10);
  const start = dateInput.safeParse(from === undefined || from === "" ? defaultStart : from);
  if (!start.success || start.data > end.data) return null;
  return {
    from: start.data,
    to: end.data,
    start: new Date(`${start.data}T00:00:00+06:00`),
    endExclusive: new Date(Date.parse(`${end.data}T00:00:00+06:00`) + dayMs),
  };
}
