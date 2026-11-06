'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { useAccountShopping } from '@/features/account/shopping-scope';
import { lineKey, maxCartLines, mergeCartLines, parseCoupon, parseLine, type CartLine, type CartSnapshot } from './cart';

const key = 'griipbuddy-cart-v1';
const event = 'griipbuddy-cart-change';
const empty = '{"version":1,"lines":[]}';
let memory: string | undefined;

function read() {
  try { return memory ?? window.localStorage.getItem(key) ?? empty; }
  catch { return memory ?? empty; }
}

function decode(snapshot: string): CartSnapshot {
  try {
    const data = JSON.parse(snapshot);
    if (data?.version === 1 && Array.isArray(data.lines)) {
      const lines = data.lines.slice(0, maxCartLines).flatMap((line: unknown) => parseLine(line) ?? []);
      const code = parseCoupon(data.coupon?.code);
      const market: unknown = data.coupon?.market;
      return {
        version: 1,
        transferId: typeof data.transferId === 'string' && /^[a-f\d-]{36}$/i.test(data.transferId) ? data.transferId : undefined,
        lines: [...new Map<string, CartLine>(lines.map((line: CartLine) => [lineKey(line), line])).values()],
        coupon: code && typeof market === 'string' && /^(?:[A-Z]{2}|INTL)$/.test(market) ? { code, market } : undefined,
      };
    }
  } catch { /* Ignore invalid local data. */ }
  return { version: 1, lines: [] };
}

function write(snapshot: CartSnapshot) {
  const next = JSON.stringify({ ...snapshot, transferId: snapshot.lines.length ? snapshot.transferId ?? crypto.randomUUID() : undefined });
  try { window.localStorage.setItem(key, next); memory = undefined; }
  catch { memory = next; }
  window.dispatchEvent(new Event(event));
}

function subscribe(listener: () => void) {
  const onStorage = (change: StorageEvent) => { if (change.key === key || change.key === null) listener(); };
  window.addEventListener(event, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(event, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function addLine(line: CartLine) {
  const current = decode(read());
  const validated = parseLine(line);
  const next = validated ? mergeCartLines(current.lines, [validated]) : undefined;
  if (!next) return false;
  write({ ...current, lines: next });
  return true;
}

export function updateQuantity(key: string, quantity: number) {
  const current = decode(read());
  const line = current.lines.find((entry) => lineKey(entry) === key);
  const updated = line ? parseLine({ ...line, quantity }) : undefined;
  if (!updated) return false;
  write({ ...current, lines: current.lines.map((entry) => lineKey(entry) === key ? updated : entry) });
  return true;
}

export function removeLine(key: string) {
  const current = decode(read());
  write({ ...current, lines: current.lines.filter((entry) => lineKey(entry) !== key) });
}

export function updateCoupon(market: string, code?: string) {
  const current = decode(read());
  write({ ...current, coupon: code ? { market, code } : undefined });
}

export function guestTransfer() {
  const cart = decode(read());
  if (!cart.lines.length) return undefined;
  if (!cart.transferId) write(cart);
  return decode(read());
}

export function clearTransferredGuestCart(original?: CartSnapshot) {
  if (original?.transferId && JSON.stringify(decode(read())) === JSON.stringify(original)) {
    write({ version: 1, lines: [] });
  }
}

export function useCart() {
  const account = useAccountShopping();
  const snapshot = useSyncExternalStore<string | null>(subscribe, read, () => null);
  const guest = useMemo(() => decode(snapshot ?? empty), [snapshot]);
  return { ...(account?.mode === 'fixture' && account.cart ? account.cart : guest), hydrated: snapshot !== null };
}

export function useBagCommands() {
  const account = useAccountShopping();
  if (account?.mode === 'fixture') return {
    add: (line: CartLine) => account.changeCart({ type: 'add', line }),
    quantity: (key: string, quantity: number) => account.changeCart({ type: 'quantity', key, quantity }),
    adjust: (key: string, delta: number) => account.changeCart({ type: 'adjust', key, delta }),
    remove: (key: string) => account.changeCart({ type: 'remove', key }),
    coupon: (market: string, code?: string) => account.changeCart({ type: 'coupon', market, code }),
    error: account.error,
  };
  return {
    add: async (line: CartLine) => addLine(line),
    quantity: async (key: string, quantity: number) => updateQuantity(key, quantity),
    adjust: async (key: string, delta: number) => {
      const line = decode(read()).lines.find((entry) => lineKey(entry) === key);
      return line ? updateQuantity(key, line.quantity + delta) : false;
    },
    remove: async (key: string) => { removeLine(key); return true; },
    coupon: async (market: string, code?: string) => { updateCoupon(market, code); return true; },
    error: '',
  };
}
