import type { Market } from "../../config/markets.ts";
import { catalogDevices } from "./devices.ts";
import { toCard } from "./listing.ts";
import type { RecommendationPlacement, RecommendationPlacementPolicy } from "./recommendation-policy.ts";
import { searchProducts } from "./search.ts";
import type { CatalogProduct, Department } from "./types.ts";

export const recommendationReasonLabels = {
  "recently-viewed": "Viewed recently",
  "search-match": "Matches a recent search",
  "saved-intent": "Based on items you saved",
  "cart-intent": "Based on items in your cart",
  "related-to-view": "Similar to a recently viewed item",
  "similar-attributes": "Shares product features",
  "compatible-complement": "Pairs with this product",
  "market-bestseller": "Bestseller in this market",
  "market-trending": "Trending in this market",
  "replenishable-purchase": "Previously purchased replenishable item",
  curated: "Selected for this placement",
  "catalog-discovery": "More to discover in this market",
} as const;

export type RecommendationReason = keyof typeof recommendationReasonLabels;
export type RecommendationIntent = {
  searchTerms?: readonly string[];
  viewed?: readonly string[];
  wishlisted?: readonly string[];
  carted?: readonly string[];
  purchased?: readonly string[];
  repurchaseDue?: readonly string[];
};
export type RecommendationItem = { productId: string; reason: RecommendationReason; product: CatalogProduct };
type Scored = RecommendationItem & { score: number };
type Demand = { bestsellers: readonly string[]; trending: readonly string[] };

export function eligibleRecommendationProduct(product: CatalogProduct, market: Pick<Market, "id" | "currency">, production: boolean) {
  if (production && product.demo) return null;
  const variants = product.variants.filter(({ offer }) => offer?.marketId === market.id &&
    offer.currency === market.currency && offer.stock > 0 && Number.isSafeInteger(offer.amountMinor) && offer.amountMinor >= 0);
  const eligible = { ...product, variants };
  return toCard(eligible)?.inStock ? eligible : null;
}

function affinity(a: CatalogProduct, b: CatalogProduct, devices: ReadonlyMap<string, Set<string>>) {
  const aDevices = devices.get(a.id);
  const bDevices = devices.get(b.id);
  const deviceMatch = aDevices && bDevices && [...aDevices].some(device => bDevices.has(device));
  const conflicts = Boolean(aDevices?.size && bDevices?.size && !deviceMatch);
  if (conflicts) return { conflicts, score: 0, deviceMatch: false };
  const tags = new Set(a.keywords.map(tag => tag.toLowerCase()).filter(tag => !tag.includes(":")));
  const shared = b.keywords.filter(tag => tags.has(tag.toLowerCase())).length;
  const score = a.departmentId === b.departmentId
    ? 12 + (deviceMatch ? 18 : 0) + (a.brand && a.brand === b.brand ? 5 : 0) + Math.min(shared, 6)
    : 0;
  return { conflicts, score, deviceMatch: Boolean(deviceMatch) };
}

function curatedAddon(anchor: CatalogProduct, candidate: CatalogProduct) {
  return anchor.keywords.some(tag => tag === `add-on:${candidate.slug}` || tag === `add-on:${candidate.id}`);
}

function diverse(rows: Scored[], limit: number) {
  const categories = new Set(rows.map(row => row.product.departmentId)).size;
  const sellers = new Set(rows.map(row => row.product.shop?.id ?? "store")).size;
  const categoryLimit = categories > 1 ? Math.max(2, Math.ceil(limit / categories)) : limit;
  const sellerLimit = sellers > 1 ? Math.max(2, Math.ceil(limit / sellers)) : limit;
  const usedCategory = new Map<string, number>();
  const usedSeller = new Map<string, number>();
  return rows.filter(({ product }) => {
    const category = product.departmentId;
    const seller = product.shop?.id ?? "store";
    const categoryCount = usedCategory.get(category) ?? 0;
    const sellerCount = usedSeller.get(seller) ?? 0;
    if (categoryCount >= categoryLimit || sellerCount >= sellerLimit) return false;
    usedCategory.set(category, categoryCount + 1);
    usedSeller.set(seller, sellerCount + 1);
    return true;
  }).slice(0, limit);
}

export function rankRecommendations({
  products, departments, placement, policy, intent = {}, demand, coPurchased = [], anchorProductId, excludeProductIds = [], limit,
}: {
  products: readonly CatalogProduct[];
  departments: ReadonlyMap<string, Department>;
  placement: RecommendationPlacement;
  policy: RecommendationPlacementPolicy;
  intent?: RecommendationIntent;
  demand: Demand;
  coPurchased?: readonly string[];
  anchorProductId?: string;
  excludeProductIds?: readonly string[];
  limit: number;
}): RecommendationItem[] {
  if (!policy.enabled || limit < 1) return [];
  const byId = new Map(products.map(product => [product.id, product]));
  const anchor = anchorProductId ? byId.get(anchorProductId) : undefined;
  if ((placement === "similar" || placement === "complementary") && !anchor) return [];
  const blocked = new Set([...policy.excludes, ...excludeProductIds, ...(anchorProductId ? [anchorProductId] : [])]);
  if (placement !== "buy-again") for (const id of intent.purchased ?? []) blocked.add(id);
  const candidates = [...byId.values()].filter(product => !blocked.has(product.id));
  const devices = new Map(products.map(product => [product.id, new Set(catalogDevices([product]).map(device => device.id))]));
  const rows = new Map<string, Scored>();
  const score = (product: CatalogProduct, value: number, reason: RecommendationReason) => {
    const adjusted = value + (policy.boosts.includes(product.id) ? 6 : 0);
    if (adjusted > (rows.get(product.id)?.score ?? 0)) rows.set(product.id, { productId: product.id, product, reason, score: adjusted });
  };
  const byOrder = (ids: readonly string[], base: number, reason: RecommendationReason) => {
    const positions = new Map(ids.map((id, index) => [id, index]));
    for (const product of candidates) {
      const index = positions.get(product.id);
      if (index !== undefined) score(product, base + (1 / (index + 1)), reason);
    }
  };

  if (placement === "continue") {
    if (policy.strategy === "history" || policy.strategy === "behavioral") byOrder(intent.viewed ?? [], 100, "recently-viewed");
  } else if (placement === "buy-again") {
    if (policy.strategy === "history" || policy.strategy === "behavioral") {
      byOrder((intent.repurchaseDue ?? []).filter(id => policy.replenishable.includes(id)), 100, "replenishable-purchase");
    }
  } else if (anchor && placement === "similar") {
    for (const product of candidates) {
      const { score: match } = affinity(anchor, product, devices);
      if (!match || policy.strategy === "curated" && !policy.fallback.includes(product.id)) continue;
      score(product, 50 + match + (policy.fallback.includes(product.id) ? 10 : 0), "similar-attributes");
    }
  } else if (anchor && placement === "complementary") {
    for (const product of candidates) {
      const { conflicts, deviceMatch } = affinity(anchor, product, devices);
      if (conflicts || product.departmentId === anchor.departmentId || product.personalization?.required) continue;
      const explicit = curatedAddon(anchor, product) || curatedAddon(product, anchor);
      const compatible = deviceMatch && /protector|accessor/.test(departments.get(product.departmentId)?.slug ?? "");
      const coPurchase = policy.strategy === "co-purchase" && coPurchased.includes(product.id);
      if (policy.strategy === "curated" && !policy.fallback.includes(product.id)) continue;
      if (explicit || compatible || coPurchase) score(product, explicit ? 100 : compatible ? 75 : 50, "compatible-complement");
    }
  } else if (placement === "bestsellers" || placement === "trending") {
    if (policy.strategy === "popularity") {
      if (placement === "bestsellers") byOrder(demand.bestsellers, 100, "market-bestseller");
      else byOrder(demand.trending, 100, "market-trending");
    }
    byOrder(policy.fallback, 30, "curated");
    byOrder(candidates.filter(product => product.featured).map(product => product.id), 15, "curated");
  } else {
    if (policy.strategy === "behavioral" || policy.strategy === "history") {
      const intentGroups = [
        [intent.carted ?? [], 155, "cart-intent"],
        [intent.wishlisted ?? [], 130, "saved-intent"],
        [intent.viewed ?? [], 90, "related-to-view"],
      ] as const;
      for (const [ids, weight, reason] of intentGroups) {
        const signals = ids.slice(0, 12);
        for (const [index, id] of signals.entries()) {
          const source = byId.get(id);
          if (!source) continue;
          for (const product of candidates) {
            if (product.id === id) {
              if (reason !== "related-to-view") score(product, weight, reason);
              continue;
            }
            const { score: match } = affinity(source, product, devices);
            if (match) score(product, weight + match - index * 2, reason);
          }
        }
      }
      (intent.searchTerms ?? []).slice(0, 6).forEach((query, index) => {
        searchProducts(candidates, departments, query).slice(0, 12).forEach((product, rank) =>
          score(product, 125 - index * 6 - rank, "search-match"));
      });
    }
    byOrder(policy.fallback, 40, "curated");
    if (policy.strategy !== "curated") {
      byOrder(demand.bestsellers, 32, "market-bestseller");
      byOrder(demand.trending, 30, "market-trending");
    }
    byOrder(candidates.filter(product => product.featured).map(product => product.id), 24, "curated");
    byOrder(candidates.map(product => product.id), 10, "catalog-discovery");
  }

  const ranked = [...rows.values()].sort((a, b) => b.score - a.score || a.productId.localeCompare(b.productId, "en"));
  const selected = diverse(ranked, limit);
  // Leave at most one slot for discovery when the rest of the lineup shows strong intent.
  if (placement === "recommended" && limit >= 4 && selected.length === limit && selected.every(row => row.score >= 80)) {
    const usedCategories = new Set(selected.map(row => row.product.departmentId));
    const replacedSeller = selected[limit - 1]?.product.shop?.id;
    const usedSellers = new Set(selected.map(row => row.product.shop?.id));
    const discovery = ranked.find(row => row.reason === "catalog-discovery" && !usedCategories.has(row.product.departmentId) &&
      (row.product.shop?.id === replacedSeller || !usedSellers.has(row.product.shop?.id)));
    if (discovery) selected[limit - 1] = discovery;
  }
  return selected.map(({ product, productId, reason }) => ({ product, productId, reason }));
}
