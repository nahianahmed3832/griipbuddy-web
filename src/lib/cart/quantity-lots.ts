import { cartItemKey, type CartItem } from "./model.ts";

type Lot = [revision: number, quantity: number];
export type QuantityLots = Record<string, Lot[]>;

// Older market rows start with aggregate quantities. Attribute those to their
// current revision, never to a checkout predating that state.
export function readQuantityLots(items: readonly CartItem[], raw: unknown, revision: number): QuantityLots {
  const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return Object.fromEntries(items.map(item => {
    const key = cartItemKey(item);
    const values = stored[key];
    let remaining = item.quantity;
    const lots = Array.isArray(values) ? values.flatMap((value: unknown): Lot[] => {
      if (!Array.isArray(value) || !Number.isInteger(value[0]) || value[0] < 0 ||
        value[0] > revision || !Number.isInteger(value[1]) || value[1] < 1 || remaining < 1) return [];
      const quantity = Math.min(value[1], remaining);
      remaining -= quantity;
      return [[value[0], quantity]];
    }) : [];
    if (remaining) lots.push([revision, remaining]);
    return [key, lots];
  }));
}

export function updateQuantityLots(items: readonly CartItem[], prior: QuantityLots, revision: number): QuantityLots {
  return readQuantityLots(items, prior, revision);
}

export function subtractPurchasedQuantities(items: readonly CartItem[], currentLots: QuantityLots,
  purchased: readonly CartItem[], checkoutRevision: number) {
  const purchasedByKey = new Map<string, number>();
  for (const line of purchased) {
    const key = cartItemKey(line);
    purchasedByKey.set(key, (purchasedByKey.get(key) ?? 0) + line.quantity);
  }
  const remaining: CartItem[] = [];
  const lots: QuantityLots = {};
  let changed = false;
  for (const item of items) {
    const key = cartItemKey(item);
    let consume = purchasedByKey.get(key) ?? 0;
    let quantity = 0;
    const lineLots = (currentLots[key] ?? []).flatMap(([revision, available]): Lot[] => {
      const removed = revision <= checkoutRevision ? Math.min(consume, available) : 0;
      consume -= removed;
      const left = available - removed;
      quantity += left;
      return left ? [[revision, left]] : [];
    });
    if (quantity !== item.quantity) changed = true;
    if (quantity) {
      remaining.push({ ...item, quantity });
      lots[key] = lineLots;
    }
  }
  return changed ? { items: remaining, lots } : { items, lots: currentLots };
}
