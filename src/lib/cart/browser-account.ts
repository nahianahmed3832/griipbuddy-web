import { storefrontPath } from "../../config/storefront-path";
import type { CartItem } from "./model";

export type CartSyncSnapshot = {
  ready: boolean;
  persistent: boolean;
  items: readonly CartItem[];
  saved: readonly CartItem[];
  sync: "guest" | "loading" | "synced" | "saving" | "error";
  message?: string;
};

export const guestSnapshot: CartSyncSnapshot = { ready: false, persistent: true, items: [], saved: [], sync: "guest" };

type Line = Pick<CartItem, "variantId" | "offerId" | "personalization">;
export type CartCommand =
  | ({ type: "add"; quantity: number } & Line)
  | ({ type: "set"; quantity: number; expectedQuantity: number } & Line)
  | ({ type: "remove" | "move-to-saved" | "restore-saved" | "remove-saved"; expectedQuantity: number } & Line)
  | { type: "complete-purchase"; orderId: string };

type GuestMerge = { operationId: string; items: readonly CartItem[]; saved: readonly CartItem[] };
type SyncOperation = { mode: "read" } | ({ mode: "merge" } & GuestMerge) | { mode: "change"; operationId: string; command: CartCommand };
type SyncResult = { shopperId?: string; revision?: number; items?: CartItem[]; saved?: CartItem[]; message?: string };

export function createAccountCart(shopperId: string, claimGuest: () => Promise<GuestMerge | undefined>, clearGuest: (merge: GuestMerge) => void) {
  const first: CartSyncSnapshot = { ...guestSnapshot, sync: "loading" };
  let snapshot = first;
  let active: Promise<boolean> | undefined;
  let failed: SyncOperation | undefined;
  let blockedMerge: GuestMerge | undefined;
  let revision = -1;
  let invalidated = false;
  const listeners = new Set<() => void>();
  const signalKey = storefrontPath("/cart") + ":account-cart-refresh";

  function setSnapshot(next: CartSyncSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function invalidate() {
    invalidated = true;
    failed = undefined;
    setSnapshot({ ...first, sync: "error", message: "Sign in again to open your account cart." });
  }

  function signal(value: string) {
    try { window.localStorage.setItem(signalKey, value); } catch { /* Other tabs still poll. */ }
  }

  async function send(operation: SyncOperation) {
    if (invalidated) return false;
    if (operation.mode === "change") setSnapshot({ ...snapshot, sync: "saving", message: undefined });
    try {
      const response = await fetch(storefrontPath("/api/cart/resolve"), {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cart-sync", shopperId, ...operation }),
        signal: AbortSignal.timeout(8000),
      });
      if (invalidated) return false;
      if (response.status === 401 || response.status === 403) {
        invalidate();
        return false;
      }
      if (response.status >= 500 || response.status === 429) throw new Error("Cart sync unavailable");
      const result = await response.json() as SyncResult;
      if (result.shopperId !== shopperId || typeof result.revision !== "number" || !result.items || !result.saved) {
        if (response.ok) throw new Error("Invalid cart response");
        failed = undefined;
        setSnapshot({ ...snapshot, sync: "error", message: result.message ?? "We couldn't update your cart." });
        return false;
      }
      failed = undefined;
      if (operation.mode === "merge") {
        blockedMerge = response.ok ? undefined : operation;
        if (response.ok) clearGuest(operation);
      }
      if (result.revision >= revision) {
        const changed = result.revision !== revision;
        revision = result.revision;
        const message = response.ok ? (blockedMerge ? snapshot.message : undefined) : result.message ?? "Your cart changed. Check your items and try again.";
        if (changed || snapshot.sync !== (message ? "error" : "synced") || snapshot.message !== message) {
          setSnapshot({ ready: true, persistent: true, items: result.items, saved: result.saved, sync: message ? "error" : "synced", message });
        }
      }
      if (response.ok && operation.mode !== "read") signal(operation.operationId);
      return response.ok;
    } catch {
      if (invalidated) return false;
      if (operation.mode !== "read") failed = operation;
      setSnapshot({ ...snapshot, sync: "error", message: "Cart sync is temporarily unavailable. Try again to sync your cart." });
      return false;
    }
  }
  function run(task: () => Promise<boolean>) {
    active = task().finally(() => { active = undefined; });
    return active;
  }

  function refresh(retry = false) {
    if (invalidated || active) return;
    void run(async () => {
      if (failed) return send(failed);
      const merge = retry && blockedMerge ? blockedMerge : !snapshot.ready ? await claimGuest() : undefined;
      return send(merge ? { mode: "merge", ...merge } : { mode: "read" });
    });
  }

  function mount() {
    const check = () => { if (document.visibilityState === "visible") refresh(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== signalKey) return;
      if (event.newValue?.startsWith("session:")) invalidate();
      else check();
    };
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 15000);
    refresh();
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", check);
      window.clearInterval(timer);
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    mount,
    invalidate() { invalidate(); signal(`session:${crypto.randomUUID()}`); },
    retry: () => refresh(true),
    async change(command: CartCommand) {
      while (active) await active;
      if (invalidated || !snapshot.ready || failed) return false;
      return run(() => send({ mode: "change", operationId: crypto.randomUUID(), command }));
    },
  };
}
