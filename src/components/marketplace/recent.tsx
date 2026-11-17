"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { Market } from "@/config/markets";
import type { ProductCardData } from "@/lib/catalog/listing";
import { storefrontBasePath, storefrontPath } from "@/config/storefront-path";
import { ProductGrid } from "../product-grid";

const key = `griipbuddy:recent${storefrontBasePath}`;
const changed = "griipbuddy-recent-changed";
const read = () => { try { return localStorage.getItem(key) ?? "[]"; } catch { return "[]"; } };
const decode = (value: string): string[] => {
  try { const items: unknown = JSON.parse(value); return Array.isArray(items) ? items.filter(item => typeof item === "string").slice(0, 12) : []; }
  catch { return []; }
};
function save(ids: string[]) {
  try { localStorage.setItem(key, JSON.stringify(ids.slice(0, 12))); window.dispatchEvent(new Event(changed)); }
  catch { /* Browsing works when storage is unavailable. */ }
}
function subscribe(callback: () => void) {
  window.addEventListener(changed, callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener(changed, callback); window.removeEventListener("storage", callback); };
}

export function RecentlyViewedProduct({ id }: { id: string }) {
  useEffect(() => { save([id, ...decode(read()).filter(item => item !== id)]); }, [id]);
  return null;
}

export function RecentlyViewed({ market, regional }: { market: Market; regional: boolean }) {
  const raw = useSyncExternalStore(subscribe, read, () => "[]");
  const [result, setResult] = useState<{ marketId: Market["id"]; raw: string; cards: ProductCardData[] }>();
  useEffect(() => {
    const ids = [...new Set(decode(raw).filter(id => id.length > 0 && id.length <= 128))];
    if (!ids.length) return;
    const controller = new AbortController();
    const search = new URLSearchParams({ market: market.id });
    for (const id of ids) search.append("id", id);
    void fetch(storefrontPath(`/api/marketplace/recent?${search}`), { signal: controller.signal })
      .then(async response => {
        if (!response.ok || controller.signal.aborted) return;
        const { cards } = await response.json() as { cards: ProductCardData[] };
        if (!controller.signal.aborted) setResult({ raw, marketId: market.id, cards });
      }).catch(() => { /* Browsing works when recent products are unavailable. */ });
    return () => controller.abort();
  }, [raw, market.id]);
  const rows = result?.marketId === market.id && result.raw === raw ? result.cards : [];
  if (!rows.length) return null;
  return <section className="mp-home-section" aria-labelledby="mp-recent-heading">
    <div className="mp-section-heading"><h2 id="mp-recent-heading">Recently viewed</h2><button type="button" onClick={() => save([])}>Clear history</button></div>
    <ProductGrid cards={rows} market={market} regional={regional}/>
  </section>;
}
