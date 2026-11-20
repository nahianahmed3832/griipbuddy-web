"use client";

import { useSyncExternalStore } from "react";
import { storefrontBasePath } from "../../config/storefront-path";
import { defaultMarketId, type MarketId } from "../../config/markets";
import { MAX_QUANTITY, validCartOfferId, validVariantId } from "./model";

const pendingKey = `griipbuddy:pending-checkout${storefrontBasePath}`;
const pendingListeners = new Set<() => void>();
const volatilePending = new Map<MarketId, string>();
const keyFor = (marketId: MarketId) => `${pendingKey}:${marketId}`;
type PendingDirect = { variantId: string; offerId?: string; quantity: number; personalizationIntent?: string };

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

export function rememberPending(marketId: MarketId, attemptId: string | null, directItem?: PendingDirect, prepaid = false) {
  const attempt = `${prepaid ? "prepaid:" : ""}${directItem ? "direct:" : ""}${attemptId}`;
  const value = !attemptId ? null : directItem ? `${attempt}|${JSON.stringify(directItem)}` : attempt;
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
  const [value, item] = raw.split("|", 2);
  const prepaid = value.startsWith("prepaid:");
  const attempt = value.replace(/^prepaid:/, "");
  const direct = attempt.startsWith("direct:");
  const id = attempt.replace(/^direct:/, "");
  if (!validCartOfferId(id)) return null;
  let directItem: PendingDirect | undefined;
  if (direct && item) {
    try {
      const parsed = JSON.parse(item) as Partial<PendingDirect> | null;
      if (parsed && validVariantId(parsed.variantId) &&
          (parsed.offerId === undefined || validCartOfferId(parsed.offerId)) && typeof parsed.quantity === "number" &&
          Number.isInteger(parsed.quantity) && parsed.quantity >= 1 && parsed.quantity <= MAX_QUANTITY) {
        directItem = { variantId: parsed.variantId, offerId: parsed.offerId, quantity: parsed.quantity,
          personalizationIntent: validCartOfferId(parsed.personalizationIntent) ? parsed.personalizationIntent : undefined };
      }
    } catch { /* Legacy attempts can still recover without direct checkout details. */ }
  }
  return { id, direct, prepaid, directItem };
}
