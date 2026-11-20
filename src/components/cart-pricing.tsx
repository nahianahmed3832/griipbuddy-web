"use client";

import { storefrontPath } from "@/config/storefront-path";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Market, MarketId } from "@/config/markets";
import { CartAccountProvider, useCart, useCartActions } from "@/lib/cart/browser";
import { cartCount, cartLookupBody, cartMarketHeader, cartOfferKey, evaluateCart } from "@/lib/cart/model";
import type { CartCatalogItem } from "@/lib/catalog/types";

type Quote = { key: string; attempt: number; items: readonly CartCatalogItem[]; priceChanged: boolean } | { key: string; attempt: number; error: true };
type CartPricing = {
  market: Market;
  ready: boolean;
  persistent: boolean;
  totalSaved: number;
  state: "loading" | "empty" | "error" | "priced";
  refreshing: boolean;
  priceChanged: boolean;
  cart: ReturnType<typeof evaluateCart> | null;
  retry: () => void;
};

const PricingContext = createContext<CartPricing | null>(null);

export async function lookupCartPrices(body: string, marketId: MarketId, signal: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal.aborted) cancel();
  const timeout = setTimeout(cancel, 8000);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await fetch(storefrontPath("/api/cart/resolve"), {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", [cartMarketHeader]: marketId },
      body, signal: controller.signal,
    });
    if (!response.ok) throw new Error("Cart lookup failed.");
    const result: { marketId: MarketId; items: CartCatalogItem[] } = await response.json();
    if (result.marketId !== marketId || !Array.isArray(result.items)) throw new Error("Cart lookup did not match the current market.");
    return result.items;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  }
}

function priceKey(item: CartCatalogItem) {
  return cartOfferKey({ variantId: item.requestedVariantId ?? item.variantId, offerId: item.requestedOfferId });
}

export function CartPricingProvider({ market, shopperId, children }: { market: Market; shopperId?: string; children: ReactNode }) {
  return <CartAccountProvider shopperId={shopperId} market={market}><CartPricingContents market={market}>{children}</CartPricingContents></CartAccountProvider>;
}

function CartPricingContents({ market, children }: { market: Market; children: ReactNode }) {
  const { items, ready, persistent, sync } = useCart();
  const { retrySync } = useCartActions();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [attempt, setAttempt] = useState(0);
  const body = items.length ? cartLookupBody(items) : "";
  const key = `${market.id}:${market.locale}:${body}`;
  const active = quote?.key === key ? quote : null;

  useEffect(() => {
    if (!body) return;
    const controller = new AbortController();
    async function getQuote() {
      try {
        const items = await lookupCartPrices(body, market.id, controller.signal);
        if (!controller.signal.aborted) setQuote(previous => {
          const prices = new Map(previous?.key === key && "items" in previous
            ? previous.items.map(item => [priceKey(item), item.offer?.amountMinor]) : []);
          const priceChanged = items.some(item => {
            const prior = prices.get(priceKey(item));
            return prior !== undefined && Boolean(item.offer && item.offer.amountMinor !== prior);
          });
          return { key, attempt, items, priceChanged };
        });
      } catch {
        if (!controller.signal.aborted) setQuote({ key, attempt, error: true });
      }
    }
    void getQuote();
    return () => controller.abort();
  }, [body, key, market.id, attempt]);

  const refreshing = Boolean(body && active?.attempt !== attempt);
  const state = !ready ? sync === "error" ? "error" : "loading" : !body ? "empty" : !active ? "loading" :
    "error" in active ? refreshing ? "loading" : "error" : "priced";
  const cart = active && "items" in active ? evaluateCart(items, active.items, market) : null;
  const priceChanged = Boolean(active && "priceChanged" in active && active.priceChanged);
  return (
    <PricingContext.Provider value={{
      market, ready, persistent, totalSaved: cartCount(items), state, refreshing, priceChanged, cart, retry: () => {
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
