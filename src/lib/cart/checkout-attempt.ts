"use client";

import { useSyncExternalStore } from "react";
import { storefrontBasePath } from "../../config/storefront-path";
import { defaultMarketId, type MarketId } from "../../config/markets";

const pendingKey = `griipbuddy:pending-checkout${storefrontBasePath}`;
const pendingListeners = new Set<() => void>();
const volatilePending = new Map<MarketId, string>();
const keyFor = (marketId: MarketId) => `${pendingKey}:${marketId}`;

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function readPending(marketId: MarketId): string | null {
  try {
    return window.sessionStorage.getItem(keyFor(marketId)) ?? volatilePending.get(marketId) ??
      (marketId === defaultMarketId ? window.sessionStorage.getItem(pendingKey) : null);
  } catch { return volatilePending.get(marketId) ?? null; }
}

export function rememberPending(marketId: MarketId, attemptId: string | null, direct = false, prepaid = false) {
  const value = attemptId ? `${prepaid ? "prepaid:" : ""}${direct ? "direct:" : ""}${attemptId}` : null;
  if (value) volatilePending.set(marketId, value);
  else volatilePending.delete(marketId);
  try {
    if (value) window.sessionStorage.setItem(keyFor(marketId), value);
    else window.sessionStorage.removeItem(keyFor(marketId));
    if (marketId === defaultMarketId) window.sessionStorage.removeItem(pendingKey);
  } catch {
    // The in-memory attempt still supports retries within this tab.
  }
  for (const listener of pendingListeners) listener();
}

export function usePendingCheckout(marketId: MarketId) {
  const raw = useSyncExternalStore(subscribePending, () => readPending(marketId), () => null);
  if (!raw) return null;
  const prepaid = raw.startsWith("prepaid:");
  const attempt = raw.replace(/^prepaid:/, "");
  return { id: attempt.replace(/^direct:/, ""), direct: attempt.startsWith("direct:"), prepaid };
}
