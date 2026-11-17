"use client";

import { useSyncExternalStore } from "react";
import { storefrontBasePath } from "../../config/storefront-path";

const pendingKey = `griipbuddy:pending-checkout${storefrontBasePath}`;
const pendingListeners = new Set<() => void>();
let volatilePending: string | null = null;

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}

function readPending(): string | null {
  try { return window.sessionStorage.getItem(pendingKey) ?? volatilePending; } catch { return volatilePending; }
}

export function rememberPending(attemptId: string | null, direct = false, prepaid = false) {
  const value = attemptId ? `${prepaid ? "prepaid:" : ""}${direct ? "direct:" : ""}${attemptId}` : null;
  volatilePending = value;
  try {
    if (value) window.sessionStorage.setItem(pendingKey, value);
    else window.sessionStorage.removeItem(pendingKey);
  } catch {
    // The in-memory attempt still supports retries within this tab.
  }
  for (const listener of pendingListeners) listener();
}

export function usePendingCheckout() {
  const raw = useSyncExternalStore(subscribePending, readPending, () => null);
  if (!raw) return null;
  const prepaid = raw.startsWith("prepaid:");
  const attempt = raw.replace(/^prepaid:/, "");
  return { id: attempt.replace(/^direct:/, ""), direct: attempt.startsWith("direct:"), prepaid };
}
