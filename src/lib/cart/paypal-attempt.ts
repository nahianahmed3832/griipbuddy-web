"use client";

import { useSyncExternalStore } from "react";
import type { MarketId } from "../../config/markets";
import { storefrontBasePath } from "../../config/storefront-path";
import { validCartOfferId, type CartItem } from "./model";

export type PendingPayPal = { id: string; cartRevision?: number; direct?: CartItem & { personalizationIntent?: string } };

const pendingKey = `griipbuddy:paypal-checkout${storefrontBasePath}`;
const pendingListeners = new Set<() => void>();
const localPending = new Map<MarketId, string>();
const keyFor = (marketId: MarketId) => `${pendingKey}:${marketId}`;

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function readPending(marketId: MarketId) {
  try {
    return window.sessionStorage.getItem(keyFor(marketId)) ?? localPending.get(marketId) ??
      (marketId === "us" ? window.sessionStorage.getItem(pendingKey) : null);
  } catch { return localPending.get(marketId) ?? null; }
}

export function rememberPaypal(marketId: MarketId, attempt: PendingPayPal | null) {
  if (attempt) localPending.set(marketId, JSON.stringify(attempt));
  else localPending.delete(marketId);
  try {
    const saved = localPending.get(marketId);
    if (saved) window.sessionStorage.setItem(keyFor(marketId), saved);
    else window.sessionStorage.removeItem(keyFor(marketId));
    if (marketId === "us") window.sessionStorage.removeItem(pendingKey);
  } catch { /* Keep the in-memory recovery reference in this tab. */ }
  for (const listener of pendingListeners) listener();
}

export function usePendingPaypal(marketId: MarketId): PendingPayPal | null {
  const raw = useSyncExternalStore(subscribePending, () => readPending(marketId), () => null);
  try {
    const saved = raw ? JSON.parse(raw) as PendingPayPal | null : null;
    return validCartOfferId(saved?.id) ? saved : null;
  } catch { return null; }
}
