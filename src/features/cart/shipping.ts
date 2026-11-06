import 'server-only';
import { apiConfigured, record } from '@/features/catalog/api';
import { checkoutPreferences, supportsCheckoutMarket } from '@/features/checkout/admin-preferences';
import { checkoutEnabled } from '@/features/checkout/runtime';
import type { Market } from '@/features/catalog/catalog';
import type { CartQuote } from './cart';

const fixtureRates = {
  US: { currency: 'USD', feeMinor: 700 },
  BD: { currency: 'BDT', feeMinor: 8000 },
};

export function shippingEstimate(market: Market): CartQuote['shipping'] {
  if (market.code === 'INTL') return { status: 'destination-required' };
  if (checkoutEnabled() && supportsCheckoutMarket(market.code)) {
    const expected = market.code === 'BD' ? 'BDT' : 'USD';
    const amount = checkoutPreferences().markets[market.code].shipping;
    return amount !== null && market.currency === expected ? { status: 'estimated', amount } : { status: 'unconfigured' };
  }
  let configured: unknown = !apiConfigured() ? fixtureRates : {};
  if (process.env.GRIIPBUDDY_SHIPPING_RATES !== undefined) {
    try { configured = JSON.parse(process.env.GRIIPBUDDY_SHIPPING_RATES); }
    catch { configured = {}; }
  }
  const rate = record(record(configured)[market.code]);
  const amount = rate.feeMinor;
  if (rate.currency !== market.currency || typeof amount !== 'number' || !Number.isSafeInteger(amount)
    || amount < 0 || amount > 1_000_000_000) return { status: 'unconfigured' };
  return { status: 'estimated', amount };
}
