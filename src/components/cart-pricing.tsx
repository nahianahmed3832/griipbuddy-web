"use client";

import { storefrontPath } from "@/config/storefront-path";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Market, MarketId } from "@/config/markets";
import { CartAccountProvider, useCart, useCartActions } from "@/lib/cart/browser";
import { cartCount, cartLookupBody, evaluateCart } from "@/lib/cart/model";
import type { CartCatalogItem } from "@/lib/catalog/types";

type Quote = { key: string; items: readonly CartCatalogItem[] } | { key: string; error: true };
type CartPricing = {
  market: Market;
  ready: boolean;
  persistent: boolean;
  totalSaved: number;
  state: "loading" | "empty" | "error" | "priced";
  cart: ReturnType<typeof evaluateCart> | null;
  retry: () => void;
};

const PricingContext = createContext<CartPricing | null>(null);

export function CartPricingProvider({ market, shopperId, children }: { market: Market; shopperId?: string; children: ReactNode }) {
  return <CartAccountProvider shopperId={shopperId} market={market}><CartPricingContents market={market}>{children}</CartPricingContents></CartAccountProvider>;
}

function CartPricingContents({ market, children }: { market: Market; children: ReactNode }) {
  const { items, ready, persistent, sync } = useCart();
  const { retrySync } = useCartActions();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [attempt, setAttempt] = useState(0);
  const body = items.length ? cartLookupBody(items) : "";
  const key = `${market.id}:${market.locale}:${body}:${attempt}`;
  const active = quote?.key === key ? quote : null;

  useEffect(() => {
    if (!body) return;
    const controller = new AbortController();
    async function getQuote() {
      try {
        const response = await fetch(storefrontPath("/api/cart/resolve"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Cart lookup failed.");
        const result: { marketId: MarketId; items: CartCatalogItem[] } = await response.json();
        if (result.marketId !== market.id) throw new Error("Market changed during cart lookup.");
        if (!controller.signal.aborted) setQuote({ key, items: result.items });
      } catch {
        if (!controller.signal.aborted) setQuote({ key, error: true });
      }
    }
    void getQuote();
    return () => controller.abort();
  }, [body, key, market.id]);

  const state = !ready ? sync === "error" ? "error" : "loading" : !body ? "empty" : !active ? "loading" : "error" in active ? "error" : "priced";
  const cart = active && "items" in active ? evaluateCart(items, active.items, market) : null;
  return (
    <PricingContext.Provider value={{
      market, ready, persistent, totalSaved: cartCount(items), state, cart, retry: () => {
        retrySync?.();
        setAttempt((value) => value + 1);
      },
    }}>
      {children}
    </PricingContext.Provider>
  );
}

export function useCartPricing(): CartPricing {
  const context = useContext(PricingContext);
  if (!context) throw new Error("Cart pricing requires a market.");
  return context;
}
