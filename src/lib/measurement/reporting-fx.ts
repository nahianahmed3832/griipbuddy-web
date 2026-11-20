import { z } from "zod";
import { marketList, type Currency } from "../../config/markets.ts";

const minorDigits = new Map(marketList.map(market => [market.currency, market.minorDigits]));
const currencyCode = z.custom<Currency>(value => minorDigits.has(value as Currency));
const settings = z.strictObject({
  currency: currencyCode,
  asOf: z.iso.date(),
  source: z.string().trim().min(1).max(160),
  rates: z.partialRecord(currencyCode, z.string().regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,8})?$/)),
});

export function reportingFx(raw: string | undefined, date: string) {
  if (!raw || raw.length > 4096) return null;
  try {
    const rateSheet = settings.parse(JSON.parse(raw));
    if (rateSheet.asOf !== date) return null;
    return rateSheet;
  } catch {
    return null;
  }
}

export function configuredReportingFx(date: string, test: boolean) {
  return (test ? reportingFx(process.env.GRIIP_REPORTING_FX_TEST, date) : null) ?? reportingFx(process.env.GRIIP_REPORTING_FX, date);
}

export function convertedTotal(rows: readonly { currency: Currency; amount: bigint | null }[], rates: NonNullable<ReturnType<typeof reportingFx>>) {
  let total = 0n;
  for (const { currency, amount } of rows) {
    if (amount === null) return null;
    if (currency === rates.currency) {
      total += amount;
      continue;
    }
    const rate = rates.rates[currency];
    if (!rate || +rate <= 0) return null;
    const [whole, fraction = ""] = rate.split(".");
    const numerator = BigInt(whole + fraction) * 10n ** BigInt(minorDigits.get(rates.currency)!);
    const denominator = 10n ** BigInt(fraction.length + minorDigits.get(currency)!);
    const scaled = (amount < 0n ? -amount : amount) * numerator;
    const rounded = (scaled * 2n + denominator) / (denominator * 2n);
    total += amount < 0n ? -rounded : rounded;
  }
  return total;
}
