"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import type { Market, MarketId } from "@/config/markets";
import { storefrontBasePath } from "@/config/storefront-path";
import { comparisonHref, comparisonLimit, comparisonProducts } from "@/lib/catalog/comparison";
import styles from "./product-discovery.module.css";

type ComparisonMarket = Pick<Market, "id" | "locale"> & { regional: boolean };

const changed = "griipbuddy-comparison-changed";
const key = (marketId: MarketId) => `griipbuddy:comparison${storefrontBasePath}:${marketId}`;
const read = (marketId: MarketId) => {
  try { return localStorage.getItem(key(marketId)) ?? "[]"; } catch { return "[]"; }
};

function decode(value: string) {
  try { return comparisonProducts(JSON.parse(value)); } catch { return []; }
}

function store(marketId: MarketId, products: readonly string[]) {
  try {
    if (products.length) localStorage.setItem(key(marketId), JSON.stringify(products));
    else localStorage.removeItem(key(marketId));
    window.dispatchEvent(new Event(changed));
    return true;
  } catch { return false; }
}

function subscribe(listener: () => void) {
  window.addEventListener(changed, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(changed, listener);
    window.removeEventListener("storage", listener);
  };
}

function useComparison(marketId: MarketId) {
  return decode(useSyncExternalStore(subscribe, () => read(marketId), () => "[]"));
}

export function CompareProduct({ slug, name, market }: { slug: string; name: string; market: ComparisonMarket }) {
  const products = useComparison(market.id);
  const [message, setMessage] = useState("");
  const selected = products.includes(slug);
  function toggle() {
    const current = decode(read(market.id));
    const present = current.includes(slug);
    if (!present && current.length >= comparisonLimit) {
      setMessage("Remove an item from your comparison before adding another.");
      return;
    }
    const next = present ? current.filter(product => product !== slug) : [...current, slug];
    setMessage(store(market.id, next) ? "" : "This browser could not save the comparison.");
  }
  return <div className={styles.actions}>
    <button type="button" className="button button--outline" aria-pressed={selected}
      aria-label={`${selected ? "Remove from comparison" : "Add to comparison"}: ${name}`} onClick={toggle}>
      {selected ? "Remove from comparison" : "Add to comparison"}</button>
    {products.length > 0 && <Link className="text-link" href={comparisonHref(market, products)} prefetch={false}>
      Compare ({products.length})</Link>}
    {message && <p className={styles.message} role="status">{message}</p>}
  </div>;
}

export function RestoreComparison({ market }: { market: ComparisonMarket }) {
  const stored = useComparison(market.id);
  if (!stored.length) return null;
  return <Link className="button button--outline" href={comparisonHref(market, stored)} prefetch={false}>Open my comparison ({stored.length})</Link>;
}

export function UpdateComparison({ market, products, remove, name }: {
  market: ComparisonMarket; products: readonly string[]; remove?: string; name?: string;
}) {
  const router = useRouter();
  return <button type="button" className="text-link" aria-label={name ? `Remove ${name} from comparison` : undefined} onClick={() => {
    const next = remove ? products.filter(product => product !== remove) : [];
    store(market.id, next);
    router.replace(comparisonHref(market, next));
  }}>{remove ? "Remove" : "Clear comparison"}</button>;
}
