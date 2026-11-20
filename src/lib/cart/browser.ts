"use client";

import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { storefrontPath } from "../../config/storefront-path";
import { defaultMarketId, type Market } from "../../config/markets";
import { personalizationText } from "../catalog/personalization";
import { captureMeasurement } from "../measurement/browser";
import { createAccountCart, guestSnapshot } from "./browser-account";
import { guestCart } from "./browser-guest";
import { applyLineChange, type LineChange } from "./line-mutations";
import { addToItems, cartItemKey, cartMarketHeader, MAX_QUANTITY, updateItems,
  type CartItemReference, type CheckoutCartItem } from "./model";

type AccountCart = ReturnType<typeof createAccountCart>;
const CartContext = createContext<{ account: AccountCart | null; market: Market } | null>(null);

export function CartAccountProvider({ shopperId, market, children }: { shopperId?: string; market: Market; children: ReactNode }) {
  const guest = guestCart(market.id);
  const account = useMemo(() => shopperId
    ? createAccountCart(shopperId, market.id, () => guest.claim(shopperId), guest.finishMerge)
    : null, [shopperId, market.id, guest]);
  useEffect(() => {
    if (account) return account.mount();
    void guest.migrate();
  }, [account, guest]);
  const context = useMemo(() => ({ account, market }), [account, market]);
  return createElement(CartContext.Provider, { value: context }, children);
}

export function useCart() {
  const context = useContext(CartContext);
  const cart = context?.account ?? guestCart(context?.market.id ?? defaultMarketId);
  return useSyncExternalStore(cart.subscribe, cart.getSnapshot, () => guestSnapshot);
}

type CartMeasurement = { productId?: string; priceMinor?: number; placement?: string; variantId?: string; offerId?: string };

async function exactOfferStock(market: Market, variantId: string, offerId: string | undefined, quantity: number, personalization?: string) {
  try {
    const response = await fetch(storefrontPath("/api/cart/resolve"), {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", [cartMarketHeader]: market.id },
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

const pendingGuestAdds = new Map<string, Promise<boolean>>();

export function useCartActions() {
  const context = useContext(CartContext);
  const account = context?.account;
  const market = context?.market;
  const guest = guestCart(market?.id ?? defaultMarketId);
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

    async function guestChange(command: LineChange, stock = MAX_QUANTITY, revision = guest.getSnapshot().revision) {
      return guest.mutate(current => {
        const next = applyLineChange(current, command, stock);
        return typeof next === "string" || next.items === current.items && next.saved === current.saved ? null : next;
      }, command.type === "add" ? undefined : revision);
    }

    return {
      async addToCart(variantId: string, quantity: number, stock: number, personalization?: string, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, quantity, details, offerId);
        const note = personalizationText(personalization);
        if (personalization !== undefined && !note) return false;
        const command = { type: "add", variantId, quantity, personalization: note, offerId } as const;
        if (account) {
          if (!addToItems(account.getSnapshot().items, variantId, quantity, stock, note, offerId)) return false;
          const added = await account.change(command);
          if (added) measure("CART_ADD");
          return added;
        }
        if (!market) return false;
        const key = JSON.stringify([market.id, cartItemKey(command), quantity]);
        const pending = pendingGuestAdds.get(key);
        if (pending) return pending;
        const submit = async () => {
          const checked = await exactOfferStock(market, variantId, offerId, quantity, note);
          const added = checked !== null && await guestChange(command, Math.min(stock, checked));
          if (added) measure("CART_ADD");
          return added;
        };
        const adding = submit().finally(() => pendingGuestAdds.delete(key));
        pendingGuestAdds.set(key, adding);
        return adding;
      },
      async setCartQuantity(variantId: string, quantity: number, stock: number, personalization: string | undefined,
        expectedQuantity: number, details?: CartMeasurement, offerId?: string, resolved?: CartItemReference) {
        if (quantity === expectedQuantity) return false;
        const measure = measureCartChange(variantId, quantity, details, offerId);
        const command = { type: "set", variantId, personalization, offerId, quantity, expectedQuantity } as const;
        const increasing = quantity > expectedQuantity;
        let updated: boolean;
        if (account) {
          const { items } = account.getSnapshot();
          updated = updateItems(items, variantId, quantity, increasing ? stock : MAX_QUANTITY, personalization, offerId) !== items &&
            await account.change(command);
        } else {
          const revision = guest.getSnapshot().revision;
          const checked = increasing
            ? market && await exactOfferStock(market, resolved?.variantId ?? variantId, resolved?.offerId ?? offerId, quantity, personalization)
            : MAX_QUANTITY;
          updated = typeof checked === "number" && await guestChange(command, checked, revision);
        }
        if (updated) measure("CART_UPDATE");
        return updated;
      },
      async removeFromCart(variantId: string, personalization: string | undefined, expectedQuantity: number, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const command = { type: "remove", variantId, personalization, offerId, expectedQuantity } as const;
        const removed = await (account ? account.change(command) : guestChange(command));
        if (removed) measure("CART_REMOVE");
        return removed;
      },
      async moveToSaved(variantId: string, personalization: string | undefined, expectedQuantity: number, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const command = { type: "move-to-saved", variantId, personalization, offerId, expectedQuantity } as const;
        const moved = await (account ? account.change(command) : guestChange(command));
        if (moved) {
          measure("CART_REMOVE");
          measure("WISHLIST_ADD");
        }
        return moved;
      },
      async restoreSaved(variantId: string, stock: number, personalization: string | undefined, expectedQuantity: number,
        details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const command = { type: "restore-saved", variantId, personalization, offerId, expectedQuantity } as const;
        const revision = guest.getSnapshot().revision;
        const checked = !account && market
          ? await exactOfferStock(market, details?.variantId ?? variantId, details?.offerId ?? offerId, expectedQuantity, personalization)
          : null;
        const restored = account
          ? Boolean(addToItems(account.getSnapshot().items, variantId, expectedQuantity, stock, personalization, offerId)) &&
            await account.change(command)
          : checked !== null && await guestChange(command, Math.min(stock, checked), revision);
        if (restored) {
          measure("WISHLIST_REMOVE");
          measure("CART_ADD");
        }
        return restored;
      },
      async removeSaved(variantId: string, personalization: string | undefined, expectedQuantity: number, details?: CartMeasurement, offerId?: string) {
        const measure = measureCartChange(variantId, expectedQuantity, details);
        const command = { type: "remove-saved", variantId, personalization, offerId, expectedQuantity } as const;
        const removed = await (account ? account.change(command) : guestChange(command));
        if (removed) measure("WISHLIST_REMOVE");
        return removed;
      },
      async completePurchase(orderId: string, purchased: readonly CheckoutCartItem[], revision?: number) {
        if (account) await account.completePurchase(orderId);
        else await guest.completePurchase(orderId, purchased, revision);
      },
      retrySync: account?.retry,
      invalidate: account?.invalidate,
    };
  }, [account, guest, market]);
}
