import 'server-only';
import type Database from 'better-sqlite3';
import { CheckoutError } from './contracts';
import { checkoutDb, transaction } from './ledger';
import { checkoutEnabled, hasSecret } from './runtime';

const markets = ['BD', 'US'] as const;
export type CheckoutMarket = (typeof markets)[number];
type MarketSettings = { cod: boolean; manual: { advancePercent: number } | null; paypal: boolean; stripe: boolean; shipping: number | null };
export type Preferences = { revision: number; fallback: string; markets: Record<CheckoutMarket,MarketSettings> };

function object(value: unknown): Record<string,unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
}
function parseEnv(value: string) {
  try { return object(JSON.parse(value)); } catch { return {}; }
}
export const sandboxProvider = {
  paypal: () => hasSecret(process.env.GRIIPBUDDY_PAYPAL_SIM_SECRET),
  stripe: () => hasSecret(process.env.GRIIPBUDDY_STRIPE_SIM_SECRET),
};
export const adminEnabled = () => checkoutEnabled() && process.env.GRIIPBUDDY_CHECKOUT_ADMIN_ENABLED === '1';

function defaultPreferences(): Preferences {
  const methods = process.env.GRIIPBUDDY_CHECKOUT_METHODS;
  const configured = methods ? parseEnv(methods) : { BD: { cod:true, manual:{ advancePercent:20 } }, US: { cod:true, paypal:true, stripe:true } };
  const rates = process.env.GRIIPBUDDY_SHIPPING_RATES;
  const shipping = rates === undefined ? { BD: { currency:'BDT', feeMinor:8000 }, US: { currency:'USD', feeMinor:700 } } : parseEnv(rates);
  const byMarket = (code: CheckoutMarket): MarketSettings => {
    const row = object(configured[code]);
    const rate = object(shipping[code]);
    const amount = rate.feeMinor;
    const percent = object(row.manual).advancePercent;
    return {
      cod: row.cod === true, paypal: row.paypal === true, stripe: row.stripe === true,
      manual: typeof percent === 'number' && Number.isInteger(percent) && percent >= 1 && percent <= 100 ? { advancePercent: percent } : null,
      shipping: rate.currency === (code === 'BD' ? 'BDT' : 'USD') && typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount <= 1_000_000_000 ? amount : null,
    };
  };
  return { revision:0, fallback:(process.env.GRIIPBUDDY_INTERNATIONAL_COUNTRY ?? 'US').trim().toUpperCase(), markets:{ BD:byMarket('BD'), US:byMarket('US') } };
}

export function checkoutPreferences(db?: Database.Database): Preferences {
  if (!checkoutEnabled()) return defaultPreferences();
  const row = (db ?? checkoutDb()).prepare('SELECT value FROM checkout_preferences WHERE id=1').get() as { value:string } | undefined;
  return row ? JSON.parse(row.value) as Preferences : defaultPreferences();
}

function updateFields(value: unknown): MarketSettings {
  const row = object(value);
  const percent = object(row.manual).advancePercent;
  if (typeof row.cod !== 'boolean' || typeof row.paypal !== 'boolean' || typeof row.stripe !== 'boolean'
    || row.shipping !== null && (typeof row.shipping !== 'number' || !Number.isSafeInteger(row.shipping) || row.shipping < 0 || row.shipping > 1_000_000_000)
    || row.manual !== null && (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 100)) {
    throw new CheckoutError(400,'Check the market settings, shipping amount and advance percentage.');
  }
  return {cod:row.cod, paypal:row.paypal, stripe:row.stripe,
    manual:row.manual === null ? null : {advancePercent:percent as number}, shipping:row.shipping};
}

export function appendAdminEvent(db: Database.Database, actor: string, action: string, target: string) {
  db.prepare('INSERT INTO checkout_admin_history(actor,action,target,created_at) VALUES(?,?,?,?)').run(actor,action,target,new Date().toISOString());
}

export function savePreferences(input: Record<string,unknown>, actor: string) {
  const code = input.market;
  const fallback = input.fallback;
  if (code !== undefined && code !== 'BD' && code !== 'US' || fallback !== undefined && fallback !== 'US' && fallback !== 'GB') {
    throw new CheckoutError(400,'Unknown sandbox market.');
  }
  if (code === undefined && fallback === undefined) throw new CheckoutError(400,'No settings to update.');
  return transaction(db => {
    const current = checkoutPreferences(db);
    if (current.revision !== input.revision) throw new CheckoutError(409,'Settings changed. Refresh and try again.');
    const markets = { ...current.markets };
    if (code) {
      const updated = updateFields(input.settings);
      if (updated.paypal && !current.markets[code].paypal && !sandboxProvider.paypal()
        || updated.stripe && !current.markets[code].stripe && !sandboxProvider.stripe()) throw new CheckoutError(409,'Configure the sandbox provider server-side before enabling it.');
      markets[code] = updated;
    }
    const next: Preferences = { revision:current.revision+1, markets, fallback:fallback ?? current.fallback };
    db.prepare('INSERT INTO checkout_preferences(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(next));
    appendAdminEvent(db, actor, 'settings-updated', code ?? 'international');
    return next;
  });
}

export function supportsCheckoutMarket(code: string): code is CheckoutMarket {
  return markets.some(market => market === code);
}
