"use client";

import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";
import { markets, type MarketId } from "../../config/markets.ts";
import { storefrontBasePath } from "../../config/storefront-path";
import { addToItems, cartItemKey, CART_STORAGE_KEY, decodeCart, MAX_CART_LINES, updateItems, type CartItem } from "./model";

type CartSnapshot = { ready: boolean; persistent: boolean; items: readonly CartItem[]; saved: readonly CartItem[] };
const initial: CartSnapshot = { ready: false, persistent: true, items: [], saved: [] };
const LegacyCartKey = CART_STORAGE_KEY + storefrontBasePath;
const MarketContext = createContext<MarketId | null>(null);

function createCartStore(market: MarketId | null) {
  const cartKey = market ? `${LegacyCartKey}:${market}` : LegacyCartKey;

  function readStoredCart() {
    const storage = window.localStorage;
    const raw = storage.getItem(cartKey);
    if (raw || !market || markets[market].stagingOnly) return raw;
    const legacy = storage.getItem(LegacyCartKey);
    if (!legacy) return null;
    const migrationKey = `${LegacyCartKey}:migrated-market`;
    const destination = storage.getItem(migrationKey);
    if (destination && destination !== market) return null;
    storage.setItem(migrationKey, market);
    storage.setItem(cartKey, legacy);
    return legacy;
  }

  let snapshot = initial;
  const listeners = new Set<() => void>();
  let appliedOrders: string[] = [];

  function readCart(): CartSnapshot {
    try {
      const raw = readStoredCart();
      let saved: readonly CartItem[] = [];
      try {
        const record = raw ? JSON.parse(raw) : null;
        appliedOrders = Array.isArray(record?.appliedOrders) ? record.appliedOrders.filter((id: unknown) => typeof id === "string").slice(-100) : [];
        if (Array.isArray(record?.saved)) saved = decodeCart(JSON.stringify(record.saved));
      } catch {
        appliedOrders = [];
      }
      return { ready: true, persistent: true, items: decodeCart(raw), saved };
    } catch {
      return { ...snapshot, ready: true, persistent: false };
    }
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== cartKey && event.key !== null) return;
    snapshot = readCart();
    notify();
  }

  function subscribe(listener: () => void) {
    if (listeners.size === 0) window.addEventListener("storage", onStorage);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) window.removeEventListener("storage", onStorage);
    };
  }

  function getSnapshot() {
    if (!snapshot.ready && typeof window !== "undefined") snapshot = readCart();
    return snapshot;
  }

  function save(items: readonly CartItem[], saved: readonly CartItem[] = snapshot.saved) {
    let persistent = true;
    try {
      const record = appliedOrders.length || saved.length ? { items, saved, appliedOrders } : items;
      window.localStorage.setItem(cartKey, JSON.stringify(record));
    } catch {
      persistent = false;
    }
    snapshot = { ready: true, persistent, items, saved };
    notify();
  }

  function addToCart(variantId: string, quantity: number, stock: number, personalization?: string): boolean {
    const items = addToItems(getSnapshot().items, variantId, quantity, stock, personalization);
    if (!items) return false;
    save(items);
    return true;
  }

  function setCartQuantity(variantId: string, quantity: number, stock: number, personalization?: string) {
    const previous = getSnapshot().items;
    const items = updateItems(previous, variantId, quantity, stock, personalization);
    if (items !== previous) save(items);
  }

  function removeFromCart(variantId: string, personalization?: string) {
    const key = cartItemKey({ variantId, personalization });
    save(getSnapshot().items.filter(item => cartItemKey(item) !== key));
  }

  function moveToSaved(variantId: string, personalization?: string): boolean {
    const { items, saved } = getSnapshot();
    const key = cartItemKey({ variantId, personalization });
    const line = items.find(item => cartItemKey(item) === key);
    const previous = saved.filter(item => cartItemKey(item) !== key);
    if (!line || previous.length >= MAX_CART_LINES) return false;
    save(items.filter(item => cartItemKey(item) !== key), [...previous, line]);
    return true;
  }

  function restoreSaved(variantId: string, stock: number, personalization?: string): boolean {
    const { items, saved } = getSnapshot();
    const key = cartItemKey({ variantId, personalization });
    const line = saved.find(item => cartItemKey(item) === key);
    if (!line) return false;
    const updated = addToItems(items, variantId, line.quantity, stock, personalization);
    if (!updated) return false;
    save(updated, saved.filter(item => cartItemKey(item) !== key));
    return true;
  }

  function removeSaved(variantId: string, personalization?: string) {
    const { items, saved } = getSnapshot();
    const key = cartItemKey({ variantId, personalization });
    save(items, saved.filter(item => cartItemKey(item) !== key));
  }

  async function completePurchase(orderId: string, purchased: readonly CartItem[]) {
    function subtractPurchasedItems() {
      const current = readCart();
      if (appliedOrders.includes(orderId)) return;
      const counts = new Map(purchased.map(item => [cartItemKey(item), item.quantity]));
      const remaining = current.items.flatMap((item) => {
        const quantity = item.quantity - (counts.get(cartItemKey(item)) ?? 0);
        return quantity > 0 ? [{ ...item, quantity }] : [];
      });
      appliedOrders = [...appliedOrders, orderId].slice(-100);
      save(remaining, current.saved);
    }
    if (navigator.locks) {
      try {
        await navigator.locks.request(cartKey, subtractPurchasedItems);
        return;
      } catch {
        // Some browsers expose the API but reject lock requests.
      }
    }
    subtractPurchasedItems();
  }
  return { subscribe, getSnapshot, addToCart, setCartQuantity, removeFromCart, moveToSaved, restoreSaved, removeSaved, completePurchase };
}

const stores = new Map<MarketId | null, ReturnType<typeof createCartStore>>();

function cartStore(market: MarketId | null) {
  const existing = stores.get(market);
  if (existing) return existing;
  const store = createCartStore(market);
  stores.set(market, store);
  return store;
}

export function CartMarketProvider({ market, children }: { market: MarketId | null; children: ReactNode }) {
  return createElement(MarketContext.Provider, { value: market }, children);
}

export function useCart(explicitMarket?: MarketId | null): CartSnapshot {
  const market = useContext(MarketContext);
  const store = cartStore(explicitMarket === undefined ? market : explicitMarket);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => initial);
}

export function useCartActions() {
  return cartStore(useContext(MarketContext));
}
