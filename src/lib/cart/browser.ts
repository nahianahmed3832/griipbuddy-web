"use client";

import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { storefrontBasePath, storefrontPath } from "../../config/storefront-path";
import type { Market } from "../../config/markets";
import { captureMeasurement } from "../measurement/browser";
import { createAccountCart, guestSnapshot, type CartSyncSnapshot } from "./browser-account";
import { addToItems, cartItemKey, CART_STORAGE_KEY, decodeCart, MAX_CART_LINES, MAX_QUANTITY, purchasedCartItem, updateItems,
  type CartItem, type CheckoutCartItem } from "./model";

type CartSnapshot = CartSyncSnapshot;
const initial = guestSnapshot;
let snapshot = initial;
const listeners = new Set<() => void>();
const cartKey = CART_STORAGE_KEY + storefrontBasePath;
let appliedOrders: string[] = [];
type GuestTransfer = { shopperId: string; operationId: string; items: readonly CartItem[]; saved: readonly CartItem[] };
let handoff: GuestTransfer | undefined;

function readHandoff(record: unknown): GuestTransfer | undefined {
  if (!record || typeof record !== "object" || !("handoff" in record)) return;
  const transfer = record.handoff;
  if (!transfer || typeof transfer !== "object" || !("shopperId" in transfer) || !("operationId" in transfer) ||
      typeof transfer.shopperId !== "string" || typeof transfer.operationId !== "string" ||
      !("items" in transfer) || !("saved" in transfer)) return;
  return { shopperId: transfer.shopperId, operationId: transfer.operationId,
    items: decodeCart(JSON.stringify(transfer.items)), saved: decodeCart(JSON.stringify(transfer.saved)) };
}

function readCart(): CartSnapshot {
  try {
    const raw = window.localStorage.getItem(cartKey);
    let saved: readonly CartItem[] = [];
    try {
      const record = raw ? JSON.parse(raw) : null;
      handoff = readHandoff(record);
      appliedOrders = Array.isArray(record?.appliedOrders) ? record.appliedOrders.filter((id: unknown) => typeof id === "string").slice(-100) : [];
      if (Array.isArray(record?.saved)) saved = decodeCart(JSON.stringify(record.saved));
    } catch {
      appliedOrders = [];
      handoff = undefined;
    }
    return { ready: true, persistent: true, items: decodeCart(raw), saved, sync: "guest" };
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

function save(items: readonly CartItem[], saved: readonly CartItem[] = snapshot.saved, preserveHandoff = true) {
  let persistent = true;
  try {
    if (preserveHandoff) {
      const raw = window.localStorage.getItem(cartKey);
      try { handoff = readHandoff(raw ? JSON.parse(raw) : null); }
      catch { handoff = undefined; }
    }
    const record = appliedOrders.length || saved.length || handoff ? { items, saved, appliedOrders, handoff } : items;
    window.localStorage.setItem(cartKey, JSON.stringify(record));
  } catch {
    persistent = false;
  }
  snapshot = { ready: true, persistent, items, saved, sync: "guest" };
  notify();
}

function addToCart(variantId: string, quantity: number, stock: number, personalization?: string, offerId?: string): boolean {
  const items = addToItems(getSnapshot().items, variantId, quantity, stock, personalization, offerId);
  if (!items) return false;
  save(items);
  return true;
}

function setCartQuantity(variantId: string, quantity: number, stock: number, personalization?: string, offerId?: string) {
  const previous = getSnapshot().items;
  const items = updateItems(previous, variantId, quantity, stock, personalization, offerId);
  if (items === previous) return false;
  save(items);
  return true;
}

function removeFromCart(variantId: string, personalization?: string, offerId?: string) {
  const key = cartItemKey({ variantId, personalization, offerId });
  const before = getSnapshot().items;
  const items = before.filter(item => cartItemKey(item) !== key);
  if (items.length === before.length) return false;
  save(items);
  return true;
}

function moveToSaved(variantId: string, personalization?: string, offerId?: string): boolean {
  const { items, saved } = getSnapshot();
  const key = cartItemKey({ variantId, personalization, offerId });
  const line = items.find(item => cartItemKey(item) === key);
  const previous = saved.filter(item => cartItemKey(item) !== key);
  if (!line || previous.length >= MAX_CART_LINES) return false;
  save(items.filter(item => cartItemKey(item) !== key), [...previous, line]);
  return true;
}

function restoreSaved(variantId: string, stock: number, personalization?: string, offerId?: string): boolean {
  const { items, saved } = getSnapshot();
  const key = cartItemKey({ variantId, personalization, offerId });
  const line = saved.find(item => cartItemKey(item) === key);
  if (!line) return false;
  const updated = addToItems(items, variantId, line.quantity, stock, personalization, offerId);
  if (!updated) return false;
  save(updated, saved.filter(item => cartItemKey(item) !== key));
  return true;
}

function removeSaved(variantId: string, personalization?: string, offerId?: string) {
  const { items, saved } = getSnapshot();
  const key = cartItemKey({ variantId, personalization, offerId });
  const updated = saved.filter(item => cartItemKey(item) !== key);
  if (updated.length === saved.length) return false;
  save(items, updated);
  return true;
}

async function withGuestLock<T>(task: () => T) {
  if (navigator.locks) {
    try { return await navigator.locks.request(cartKey, task); }
    catch { /* Some browsers reject lock requests. */ }
  }
  return task();
}

function subtract(items: readonly CartItem[], removed: readonly CartItem[]) {
  const counts = new Map(removed.map(item => [cartItemKey(item), item.quantity]));
  return items.flatMap(item => {
    const quantity = item.quantity - (counts.get(cartItemKey(item)) ?? 0);
    return quantity > 0 ? [{ ...item, quantity }] : [];
  });
}

async function claimGuest(shopperId: string) {
  return withGuestLock(() => {
    const { items, saved } = readCart();
    if (handoff) return handoff.shopperId === shopperId ? handoff : undefined;
    if (!items.length && !saved.length) return;
    const transfer = { shopperId, operationId: crypto.randomUUID(), items, saved };
    handoff = transfer;
    save(items, saved, false);
    return transfer;
  });
}

function clearGuest(operation: { operationId: string }) {
  const { items, saved } = readCart();
  if (handoff?.operationId !== operation.operationId) return;
  const completed = handoff;
  handoff = undefined;
  save(subtract(items, completed.items), subtract(saved, completed.saved), false);
}

async function completePurchase(orderId: string, purchased: readonly CheckoutCartItem[]) {
  function subtractPurchasedItems() {
    const current = readCart();
    if (appliedOrders.includes(orderId)) return;
    appliedOrders = [...appliedOrders, orderId].slice(-100);
    save(subtract(current.items, purchased.map(purchasedCartItem)), current.saved);
  }
  await withGuestLock(subtractPurchasedItems);
}

type AccountCart = ReturnType<typeof createAccountCart>;
const CartContext = createContext<{ account: AccountCart | null; market: Market } | null>(null);

export function CartAccountProvider({ shopperId, market, children }: { shopperId?: string; market: Market; children: ReactNode }) {
  const account = useMemo(() => shopperId ? createAccountCart(shopperId, () => claimGuest(shopperId), clearGuest) : null, [shopperId]);
  useEffect(() => account?.mount(), [account]);
  const context = useMemo(() => ({ account, market }), [account, market]);
  return createElement(CartContext.Provider, { value: context }, children);
}

export function useCart(): CartSnapshot {
  const account = useContext(CartContext)?.account;
  return useSyncExternalStore(account?.subscribe ?? subscribe, account?.getSnapshot ?? getSnapshot, () => initial);
}

type CartMeasurement = { productId?: string; priceMinor?: number; placement?: string; variantId?: string; offerId?: string };

async function exactOfferStock(market: Market, variantId: string, offerId: string, quantity: number, personalization?: string) {
  try {
    const response = await fetch(storefrontPath("/api/cart/resolve"), {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "validate-add", marketId: market.id, variantId, offerId, quantity, personalization }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const result = await response.json() as { marketId?: string; stock?: number };
    return result.marketId === market.id && typeof result.stock === "number" &&
      Number.isInteger(result.stock) && result.stock >= quantity && result.stock <= MAX_QUANTITY ? result.stock : null;
  } catch {
    return null;
  }
}

export function useCartActions() {
  const context = useContext(CartContext);
  const account = context?.account;
  const market = context?.market;
  return useMemo(() => {
    function measureCartChange(variantId: string, quantity: number, details?: CartMeasurement, offerId?: string) {
      const report = captureMeasurement();
      return (action: "CART_ADD" | "CART_UPDATE" | "CART_REMOVE" | "WISHLIST_ADD" | "WISHLIST_REMOVE") => {
        if (market) report({ action, variantId: details?.variantId ?? variantId, offerId: details?.offerId ?? offerId,
          quantity, marketId: market.id, productId: details?.productId,
          displayedPriceMinor: details?.priceMinor, currency: details?.priceMinor === undefined ? undefined : market.currency,
          placement: details?.placement ?? "cart" });
      };
    }
    return {
      async addToCart(variantId: string, quantity: number, stock: number, personalization?: string, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, quantity, details, offerId);
        let added: boolean;
        if (account) {
          added = Boolean(addToItems(account.getSnapshot().items, variantId, quantity, stock, personalization, offerId)) &&
            await account.change({ type: "add", variantId, quantity, personalization, offerId });
        } else if (offerId) {
          const checked = market ? await exactOfferStock(market, variantId, offerId, quantity, personalization) : null;
          if (checked === null) return false;
          added = await withGuestLock(() => {
            snapshot = readCart();
            return addToCart(variantId, quantity, Math.min(stock, checked), personalization, offerId);
          });
        } else {
          added = addToCart(variantId, quantity, stock, personalization);
        }
        if (added) measure("CART_ADD");
        return added;
      },
      async setCartQuantity(variantId: string, quantity: number, stock: number, personalization: string | undefined,
        expectedQuantity: number, details?: CartMeasurement, offerId?: string) {
        if (quantity === expectedQuantity) return;
        const measure = measureCartChange(variantId, quantity, details);
        const updated = account
          ? updateItems(account.getSnapshot().items, variantId, quantity, stock, personalization, offerId) !== account.getSnapshot().items &&
            await account.change({ type: "set", variantId, personalization, offerId, quantity, expectedQuantity })
          : setCartQuantity(variantId, quantity, stock, personalization, offerId);
        if (updated) measure("CART_UPDATE");
      },
      async removeFromCart(variantId: string, personalization: string | undefined, expectedQuantity: number, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const removed = account
          ? await account.change({ type: "remove", variantId, personalization, offerId, expectedQuantity })
          : removeFromCart(variantId, personalization, offerId);
        if (removed) measure("CART_REMOVE");
        return removed;
      },
      async moveToSaved(variantId: string, personalization: string | undefined, expectedQuantity: number, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const moved = account
          ? await account.change({ type: "move-to-saved", variantId, personalization, offerId, expectedQuantity })
          : moveToSaved(variantId, personalization, offerId);
        if (moved) {
          measure("CART_REMOVE");
          measure("WISHLIST_ADD");
        }
        return moved;
      },
      async restoreSaved(variantId: string, stock: number, personalization: string | undefined, expectedQuantity: number,
        details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const restored = account
          ? Boolean(addToItems(account.getSnapshot().items, variantId, expectedQuantity, stock, personalization, offerId)) &&
            await account.change({ type: "restore-saved", variantId, personalization, offerId, expectedQuantity })
          : restoreSaved(variantId, stock, personalization, offerId);
        if (restored) {
          measure("WISHLIST_REMOVE");
          measure("CART_ADD");
        }
        return restored;
      },
      async removeSaved(variantId: string, personalization: string | undefined, expectedQuantity: number, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const removed = account
          ? await account.change({ type: "remove-saved", variantId, personalization, offerId, expectedQuantity })
          : removeSaved(variantId, personalization, offerId);
        if (removed) measure("WISHLIST_REMOVE");
        return removed;
      },
      async completePurchase(orderId: string, purchased: readonly CheckoutCartItem[]) {
        if (account) await account.change({ type: "complete-purchase", orderId });
        else await completePurchase(orderId, purchased);
      },
      retrySync: account?.retry,
      invalidate: account?.invalidate,
    };
  }, [account, market]);
}
