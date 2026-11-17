"use client";

import { storefrontPath } from "@/config/storefront-path";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Market, MarketId } from "@/config/markets";
import { CartMarketProvider, useCart } from "@/lib/cart/browser";
import { cartCount, evaluateCart } from "@/lib/cart/model";
import type { CartCatalogItem } from "@/lib/catalog/types";

type Quote = { key: string; items: readonly CartCatalogItem[] } | { key: string; error: true };
type CartPricing = {
  market: Market;
  regionalRouting: boolean;
  ready: boolean;
  persistent: boolean;
  totalSaved: number;
  state: "loading" | "empty" | "error" | "priced";
  cart: ReturnType<typeof evaluateCart> | null;
  retry: () => void;
};

const PricingContext = createContext<CartPricing | null>(null);

export function CartPricingProvider({ market, regionalRouting, children }: { market: Market; regionalRouting: boolean; children: ReactNode }) {
  const { items, ready, persistent } = useCart(regionalRouting ? market.id : null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ids = [...new Set(items.map(item => item.variantId))].sort().join(",");
  const key = `${market.id}:${ids}:${attempt}`;
  const active = quote?.key === key ? quote : null;

  useEffect(() => {
    if (!ids) return;
    const controller = new AbortController();
    async function getQuote() {
      try {
        const response = await fetch(storefrontPath("/api/cart/resolve"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variantIds: ids.split(","), ...(regionalRouting && { marketId: market.id }) }),
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
  }, [ids, key, market.id, regionalRouting]);

  const state = !ready ? "loading" : !ids ? "empty" : !active ? "loading" : "error" in active ? "error" : "priced";
  const cart = active && "items" in active ? evaluateCart(items, active.items, market) : null;
  return (
    <PricingContext.Provider value={{
      market, regionalRouting, ready, persistent, totalSaved: cartCount(items), state, cart, retry: () => setAttempt((value) => value + 1),
    }}>
      <CartMarketProvider market={regionalRouting ? market.id : null}>{children}</CartMarketProvider>
    </PricingContext.Provider>
  );
}

export function useCartPricing(): CartPricing {
  const context = useContext(PricingContext);
  if (!context) throw new Error("Cart pricing requires a market.");
  return context;
}
