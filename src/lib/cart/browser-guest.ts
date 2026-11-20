import type { MarketId } from "../../config/markets.ts";
import { storefrontBasePath, storefrontPath } from "../../config/storefront-path.ts";
import { guestSnapshot, type CartSyncSnapshot, type GuestMerge } from "./browser-account.ts";
import {
  cartItemKey, cartMarketHeader, cartOfferKey, cartReferences, CART_STORAGE_KEY, decodeCart, marketCartStorageKey,
  MAX_CART_LINES, MAX_QUANTITY, purchasedCartItem, type CartItem, type CheckoutCartItem,
} from "./model.ts";
import { readQuantityLots, subtractPurchasedQuantities, updateQuantityLots, type QuantityLots } from "./quantity-lots.ts";

type Lines = Pick<CartSyncSnapshot, "items" | "saved">;
type GuestTransfer = GuestMerge & { shopperId: string; revision: number };
const legacyKey = CART_STORAGE_KEY + storefrontBasePath;
const knownCarts = new Map<MarketId, ReturnType<typeof createGuestCart>>();

function readHandoff(value: unknown): GuestTransfer | undefined {
  if (!value || typeof value !== "object") return;
  const transfer = value as Partial<GuestTransfer>;
  if (typeof transfer.shopperId !== "string" || typeof transfer.operationId !== "string" ||
      typeof transfer.revision !== "number" || !Number.isSafeInteger(transfer.revision) || transfer.revision < 0 ||
      !Array.isArray(transfer.items) || !Array.isArray(transfer.saved)) return;
  return { shopperId: transfer.shopperId, operationId: transfer.operationId, revision: transfer.revision,
    items: decodeCart(JSON.stringify(transfer.items)), saved: decodeCart(JSON.stringify(transfer.saved)) };
}

function createGuestCart(marketId: MarketId) {
  const cartKey = marketCartStorageKey(marketId, storefrontBasePath);
  const listeners = new Set<() => void>();
  let snapshot = guestSnapshot;
  let lots: QuantityLots = {};
  let savedLots: QuantityLots = {};
  let appliedOrders: string[] = [];
  let handoff: GuestTransfer | undefined;
  let legacyChecked = false;
  let migrating: Promise<void> | undefined;

  function readCart(): CartSyncSnapshot {
    // Keep the newest in-memory version when storage was unavailable for a write.
    if (snapshot.ready && !snapshot.persistent) return snapshot;
    try {
      const raw = window.localStorage.getItem(cartKey);
      const record = raw ? JSON.parse(raw) : null;
      const items = decodeCart(raw);
      const saved = decodeCart(JSON.stringify(record?.saved ?? []));
      const revision = Number.isSafeInteger(record?.revision) && record.revision >= 0 ? Number(record.revision) : 0;
      handoff = readHandoff(record?.handoff);
      appliedOrders = Array.isArray(record?.appliedOrders) ? record.appliedOrders.filter((id: unknown) => typeof id === "string").slice(-100) : [];
      lots = readQuantityLots(items, record?.lots, revision);
      savedLots = readQuantityLots(saved, record?.savedLots, revision);
      legacyChecked = record?.legacyChecked === true;
      return { ready: true, persistent: true, revision, items, saved, sync: "guest" };
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

  function save(lines: Lines, revision: number, nextLots: QuantityLots, nextSavedLots: QuantityLots) {
    let persistent = true;
    lots = nextLots;
    savedLots = nextSavedLots;
    try {
      window.localStorage.setItem(cartKey, JSON.stringify({ ...lines, revision, lots, savedLots, appliedOrders, handoff, legacyChecked }));
    } catch {
      persistent = false;
    }
    snapshot = { ...lines, revision, ready: true, persistent, sync: "guest" };
    notify();
  }

  async function locked<T>(task: () => T) {
    let began = false;
    if (navigator.locks) {
      try {
        return await navigator.locks.request(cartKey, () => {
          began = true;
          return task();
        });
      } catch (error) {
        if (began) throw error;
      }
    }
    return task();
  }

  async function mutate(transform: (snapshot: CartSyncSnapshot) => Lines | null, expectedRevision?: number) {
    return locked(() => {
      snapshot = readCart();
      if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) return false;
      const next = transform(snapshot);
      if (!next) return false;
      const revision = snapshot.revision + 1;
      save(next, revision, updateQuantityLots(next.items, lots, revision), updateQuantityLots(next.saved, savedLots, revision));
      return true;
    });
  }

  async function importVerifiedLegacy() {
    try {
      if (legacyChecked) return;
      const raw = window.localStorage.getItem(legacyKey);
      if (!raw) return;
      const old = JSON.parse(raw);
      // An older unscoped signed-in handoff may already have been applied.
      // Keep that record available without merging it into the new carts.
      if (old?.handoff) return;
      const items = decodeCart(raw);
      const saved = decodeCart(JSON.stringify(old?.saved ?? []));
      const lines = cartReferences([...items, ...saved]).filter(line => line.offerId);
      if (!lines.length) return;
      const response = await fetch(storefrontPath("/api/cart/resolve"), {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", [cartMarketHeader]: marketId },
        body: JSON.stringify({ action: "legacy-market-cart", marketId, lines }), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const data = await response.json() as { marketId?: MarketId; matched?: CartItem[] };
      if (data.marketId !== marketId || !Array.isArray(data.matched)) return;
      const matches = new Set(data.matched.map(cartOfferKey));
      await locked(() => {
        snapshot = readCart();
        if (legacyChecked) return;
        const merge = (prior: readonly CartItem[], oldLines: readonly CartItem[]) => {
          const result = [...prior];
          const existing = new Set(prior.map(cartItemKey));
          for (const line of oldLines) {
            if (result.length >= MAX_CART_LINES || existing.has(cartItemKey(line)) || !matches.has(cartOfferKey(line))) continue;
            if (result.filter(row => row.variantId === line.variantId).reduce((sum, row) => sum + row.quantity, line.quantity) > MAX_QUANTITY) continue;
            result.push(line);
          }
          return result;
        };
        const next = { items: merge(snapshot.items, items), saved: merge(snapshot.saved, saved) };
        const revision = snapshot.revision + Number(next.items.length !== snapshot.items.length || next.saved.length !== snapshot.saved.length);
        legacyChecked = true;
        save(next, revision, updateQuantityLots(next.items, lots, revision), updateQuantityLots(next.saved, savedLots, revision));
      });
    } catch { /* Preserve the old record when proof or browser storage is unavailable. */ }
  }

  function migrate() {
    getSnapshot();
    migrating ??= importVerifiedLegacy().finally(() => { migrating = undefined; });
    return migrating;
  }

  async function claim(shopperId: string) {
    await migrate();
    return locked(() => {
      const { items, saved, revision } = readCart();
      if (handoff && handoff.shopperId !== shopperId) return;
      if (!handoff) {
        if (!items.length && !saved.length) return;
        handoff = { shopperId, operationId: crypto.randomUUID(), items, saved, revision };
        save({ items, saved }, revision, lots, savedLots);
      }
      return { operationId: handoff.operationId, items: handoff.items, saved: handoff.saved };
    });
  }

  async function finishMerge(operation: GuestMerge) {
    return locked(() => {
      const current = readCart();
      if (handoff?.operationId !== operation.operationId) return;
      const items = subtractPurchasedQuantities(current.items, lots, handoff.items, handoff.revision);
      const saved = subtractPurchasedQuantities(current.saved, savedLots, handoff.saved, handoff.revision);
      handoff = undefined;
      save({ items: items.items, saved: saved.items }, current.revision + 1, items.lots, saved.lots);
    });
  }

  async function completePurchase(orderId: string, purchased: readonly CheckoutCartItem[], checkoutRevision?: number) {
    if (checkoutRevision === undefined) return;
    await locked(() => {
      const current = readCart();
      if (appliedOrders.includes(orderId) || checkoutRevision > current.revision) return;
      appliedOrders = [...appliedOrders, orderId].slice(-100);
      const bought = subtractPurchasedQuantities(current.items, lots, purchased.map(purchasedCartItem), checkoutRevision);
      save({ items: bought.items, saved: current.saved }, current.revision + 1, bought.lots, savedLots);
    });
  }

  return { subscribe, getSnapshot, migrate, mutate, claim, finishMerge, completePurchase };
}

export function guestCart(marketId: MarketId) {
  const prior = knownCarts.get(marketId);
  if (prior) return prior;
  const cart = createGuestCart(marketId);
  knownCarts.set(marketId, cart);
  return cart;
}
