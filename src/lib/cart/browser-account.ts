import { storefrontPath } from "../../config/storefront-path.ts";
import { personalizationText } from "../catalog/personalization.ts";
import { cartItemKey, validCartOfferId, type CartItem } from "./model.ts";
import { cartSyncRequest, type CartChange } from "./sync-contract.ts";

export type CartSyncSnapshot = {
  ready: boolean;
  persistent: boolean;
  items: readonly CartItem[];
  saved: readonly CartItem[];
  sync: "guest" | "loading" | "synced" | "saving" | "error";
  message?: string;
};

export const guestSnapshot: CartSyncSnapshot = { ready: false, persistent: true, items: [], saved: [], sync: "guest" };

export type CartCommand = CartChange;

type GuestMerge = { operationId: string; items: readonly CartItem[]; saved: readonly CartItem[] };
type PendingChange = { mode: "change"; operationId: string; command: CartCommand };
type SyncOperation = { mode: "read" } | ({ mode: "merge" } & GuestMerge) | PendingChange;
type SyncResult = { shopperId?: string; revision?: number; items?: CartItem[]; saved?: CartItem[]; message?: string };

function commandKey(command: CartCommand) {
  if (command.type === "complete-purchase") return `complete-purchase:${command.orderId}`;
  return JSON.stringify([command.type, cartItemKey({ ...command, personalization: personalizationText(command.personalization) }),
    "quantity" in command ? command.quantity : null, "expectedQuantity" in command ? command.expectedQuantity : null]);
}

export function createAccountCart(shopperId: string, claimGuest: () => Promise<GuestMerge | undefined>, clearGuest: (merge: GuestMerge) => void) {
  const first: CartSyncSnapshot = { ...guestSnapshot, sync: "loading" };
  let snapshot = first;
  let active: Promise<boolean> | undefined;
  let failed: SyncOperation | undefined;
  let blockedMerge: GuestMerge | undefined;
  let revision = -1;
  let invalidated = false;
  const listeners = new Set<() => void>();
  const pending = new Set<string>();
  const signalKey = storefrontPath("/cart") + ":account-cart-refresh";
  const pendingKey = `${signalKey}:pending:${shopperId}`;
  const purchasesKey = `${signalKey}:purchases:${shopperId}`;
  const purchases = new Set<string>();

  function storedChange(): PendingChange | undefined {
    try {
      const raw = window.sessionStorage.getItem(pendingKey);
      if (!raw) return;
      const { operationId, command } = JSON.parse(raw);
      const parsed = cartSyncRequest.safeParse({ action: "cart-sync", shopperId, mode: "change", operationId, command });
      if (!parsed.success || parsed.data.mode !== "change") return;
      return { mode: "change", operationId: parsed.data.operationId, command: parsed.data.command };
    } catch { /* Continue in memory when the tab's storage is unavailable. */ }
  }

  function retainChange(operation: PendingChange) {
    try { window.sessionStorage.setItem(pendingKey, JSON.stringify(operation)); } catch { /* Continue in memory. */ }
  }

  function clearChange(operationId?: string) {
    try {
      if (!operationId || storedChange()?.operationId === operationId) window.sessionStorage.removeItem(pendingKey);
    } catch { /* The tab's storage is unavailable. */ }
  }

  function retainPurchases() {
    try {
      if (purchases.size) window.sessionStorage.setItem(purchasesKey, JSON.stringify([...purchases]));
      else window.sessionStorage.removeItem(purchasesKey);
    } catch { /* Continue in memory. */ }
  }

  function settleChange(operation: PendingChange) {
    clearChange(operation.operationId);
    if (operation.command.type === "complete-purchase" && purchases.delete(operation.command.orderId)) retainPurchases();
  }

  function setSnapshot(next: CartSyncSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function invalidate() {
    invalidated = true;
    failed = undefined;
    clearChange();
    purchases.clear();
    retainPurchases();
    setSnapshot({ ...first, sync: "error", message: "Sign in again to open your account cart." });
  }

  function signal(value: string) {
    try { window.localStorage.setItem(signalKey, value); } catch { /* Other tabs still poll. */ }
  }

  async function send(operation: SyncOperation) {
    if (invalidated) return false;
    if (operation.mode === "change") {
      // Keep the receipt key through a reload even if the original response never arrives.
      retainChange(operation);
      setSnapshot({ ...snapshot, sync: "saving", message: undefined });
    }
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
      if (result.shopperId !== shopperId || typeof result.revision !== "number" || !Array.isArray(result.items) || !Array.isArray(result.saved)) {
        if (response.ok) throw new Error("Invalid cart response");
        if (operation.mode === "change") settleChange(operation);
        failed = undefined;
        setSnapshot({ ...snapshot, sync: "error", message: result.message ?? "We couldn't update your cart." });
        return false;
      }
      if (operation.mode === "change") settleChange(operation);
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

  async function completeQueuedPurchases() {
    if (failed || invalidated || !snapshot.ready || blockedMerge) return false;
    for (const orderId of purchases) {
      await send({ mode: "change", operationId: orderId, command: { type: "complete-purchase", orderId } });
      if (failed || invalidated) return false;
    }
    return true;
  }

  function refresh(retry = false) {
    if (invalidated || active) return;
    void run(async () => {
      if (failed) await send(failed);
      else {
        const merge = retry && blockedMerge ? blockedMerge : !snapshot.ready ? await claimGuest() : undefined;
        await send(merge ? { mode: "merge", ...merge } : { mode: "read" });
      }
      return completeQueuedPurchases();
    });
  }

  function mount() {
    failed ??= storedChange();
    try {
      const orders: unknown = JSON.parse(window.sessionStorage.getItem(purchasesKey) ?? "[]");
      if (Array.isArray(orders)) for (const orderId of orders) if (validCartOfferId(orderId)) purchases.add(orderId);
    } catch { /* Continue in memory when the tab's storage is unavailable. */ }
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
      const key = commandKey(command);
      if (pending.has(key)) return false;
      pending.add(key);
      const earlierFailure = failed;
      try {
        while (active) {
          await active;
          if (earlierFailure && failed !== earlierFailure) return false;
        }
        if (invalidated || !snapshot.ready) return false;
        if (failed && (failed.mode !== "change" || commandKey(failed.command) !== key)) return false;
        return await run(() => send(failed ?? { mode: "change", operationId: crypto.randomUUID(), command }));
      } finally {
        pending.delete(key);
      }
    },
    async completePurchase(orderId: string) {
      if (invalidated || !validCartOfferId(orderId)) return;
      // A placed order can outlive a failed cart update and navigation to confirmation.
      purchases.add(orderId);
      retainPurchases();
      while (active) await active;
      if (purchases.has(orderId)) await run(completeQueuedPurchases);
    },
  };
}
