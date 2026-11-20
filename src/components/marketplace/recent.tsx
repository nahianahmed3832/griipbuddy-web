"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import type { Market, MarketId } from "@/config/markets";
import { catalogBrowseHref } from "@/lib/catalog/catalog-browse-href";
import type { ProductCardData } from "@/lib/catalog/listing";
import { recentHistoryChanged as changed, recentHistoryKey as key } from "@/lib/catalog/recent-history";
import { chooseRecommendations, useRecommendationStatus } from "@/lib/catalog/recommendation-preference-client";
import { ProductGrid } from "../product-grid";
import { MeasuredHomepageSection, type Placement } from "../measurement-observers";

const read = (market: MarketId, scope: string) => { try { return localStorage.getItem(key(market, scope)) ?? "[]"; } catch { return "[]"; } };
function decode(value: string): string[] {
  try {
    const items: unknown = JSON.parse(value);
    return Array.isArray(items) ? items.filter(item => typeof item === "string").slice(0, 12) : [];
  } catch { return []; }
}
function save(market: MarketId, scope: string, ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(key(market, scope), JSON.stringify(ids.slice(0, 12)));
    else localStorage.removeItem(key(market, scope));
    window.dispatchEvent(new Event(changed));
  } catch { /* Browsing works when storage is unavailable. */ }
}
function subscribe(callback: () => void) {
  window.addEventListener(changed, callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener(changed, callback); window.removeEventListener("storage", callback); };
}

export function RecentlyViewedProduct({ id, marketId, personalizationEnabled }: { id: string; marketId: MarketId; personalizationEnabled: boolean }) {
  const { choice, scope } = useRecommendationStatus(marketId);
  useEffect(() => {
    if (personalizationEnabled && choice === "on" && scope) {
      save(marketId, scope, [id, ...decode(read(marketId, scope)).filter(item => item !== id)]);
    }
  }, [id, marketId, choice, scope, personalizationEnabled]);
  return null;
}

export function useRecentlyViewedIds(marketId: MarketId) {
  const { choice, scope } = useRecommendationStatus(marketId);
  const raw = useSyncExternalStore(subscribe, () => scope ? read(marketId, scope) : "[]", () => "[]");
  return { choice, ids: choice === "on" && scope ? decode(raw) : [] };
}

export function RecentlyViewedLink({ market }: { market: Parameters<typeof catalogBrowseHref>[1] }) {
  const { ids } = useRecentlyViewedIds(market.id);
  return ids.length ? <Link className="text-link" href={catalogBrowseHref("/recent", market)} prefetch={false}>Recently viewed</Link> : null;
}

type Candidate = { card: ProductCardData; departmentId: string; similarEligible?: boolean };

export function RecentlyViewed({ items, market, placement, similar, title, heading, limit }: {
  items: readonly Candidate[]; market: Market; placement: Placement; similar: boolean; title: string; heading: string; limit: number;
}) {
  const { ids } = useRecentlyViewedIds(market.id);
  if (!ids.length) return null;
  const byId = new Map(items.map(row => [row.card.id, row]));
  const viewed = ids.flatMap(id => byId.get(id) ?? []);
  const departments = new Set(viewed.map(row => row.departmentId));
  const rows = similar
    ? items.filter(row => departments.has(row.departmentId) && !ids.includes(row.card.id) && row.similarEligible !== false)
    : viewed;
  if (!rows.length) return null;
  return <MeasuredHomepageSection marketId={market.id} context={placement} className="home-section" aria-labelledby={heading}>
    <div className="mp-section-heading"><h2 id={heading}>{title}</h2>
      {!similar && <button type="button" className="button button--text" onClick={() => void chooseRecommendations("reset", market.id)}>Clear history</button>}
    </div>
    <ProductGrid cards={rows.slice(0, limit).map(row => row.card)} market={market} placement={placement} />
  </MeasuredHomepageSection>;
}
