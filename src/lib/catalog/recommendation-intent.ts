import type { Currency, MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { safeSearchQuery } from "../measurement/search-privacy.ts";
import { productionMode } from "../release-config.ts";
import type { RecommendationPreference } from "./recommendation-preferences.ts";
import type { RecommendationIntent } from "./recommendation-rules.ts";

const day = 86_400_000;
const noIntent: RecommendationIntent = {};
const recentActions = ["PRODUCT_VIEW", "SEARCH", "SEARCH_FILTER", "WISHLIST_ADD", "WISHLIST_REMOVE", "CART_ADD", "CART_UPDATE", "CART_REMOVE"] as const;
type Signal = typeof recentActions[number];

export async function shopperRecommendationIntent(
  { enabled, journeyId, since, shopperId, shopperKey, associatedAt }: RecommendationPreference,
  marketId: MarketId,
  currency: Currency,
  at = new Date(),
): Promise<RecommendationIntent> {
  if (!enabled || !journeyId || !since) return noIntent;
  const now = +at;
  const db = getDb();
  const accountReset = shopperId ? await db.recommendationAccountReset.findUnique({ where: { shopperId }, select: { since: true } }) : null;
  const activitySince = new Date(Math.max(+since, +(accountReset?.since ?? 0), now - 7 * day));
  const purchasesSince = new Date(Math.max(+(accountReset?.since ?? (shopperId ? 0 : since)), now - 180 * day));
  const [activity, purchases] = await Promise.all([
    db.measurementEvent.findMany({
      where: {
        journeyId, marketId, at: { gte: activitySince, lte: at }, receivedAt: { gte: activitySince, lte: at },
        kind: { in: [...recentActions] },
        ...(shopperKey && associatedAt ? { OR: [{ accountKey: shopperKey, at: { gte: new Date(Math.max(+activitySince, +associatedAt)) } },
            { accountKey: null, at: { gte: activitySince, lt: associatedAt }, receivedAt: { gte: activitySince, lt: associatedAt } }] }
          : { accountKey: null }),
      },
      select: { kind: true, productId: true, variantId: true, details: true, quantity: true },
      orderBy: [{ at: "desc" }, { receivedAt: "desc" }, { id: "desc" }], take: 200,
    }),
    db.order.findMany({
      where: {
        marketId, status: "PLACED", fulfillmentStatus: "DELIVERED", measurementTest: !productionMode(),
        currency, createdAt: { gte: purchasesSince, lte: at },
        payment: { status: { in: ["COLLECTED", "PAID"] } },
        OR: [
          ...(shopperId ? [{ shopperId }] : []),
          { shopperId: null, createdAt: { gte: activitySince, ...(associatedAt && { lt: associatedAt }) }, measurement: { journeyId } },
        ],
        // A pending or successful return can signal that this purchase is a poor recommendation.
        cases: { none: { kind: { in: ["RETURN", "EXCHANGE"] }, status: { notIn: ["DECLINED", "WITHDRAWN"] } } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 60,
      select: { createdAt: true, items: { select: { variant: { select: { productId: true } } } } },
    }),
  ]);
  const searchTerms = new Set<string>();
  const viewed = new Set<string>();
  const wishlisted = new Set<string>();
  const carted = new Set<string>();
  const seenWishlist = new Set<string>();
  const seenCart = new Set<string>();
  for (const { kind, productId, variantId, details, quantity } of activity) {
    const signal = kind as Signal;
    if (signal === "SEARCH" || signal === "SEARCH_FILTER") {
      if (details && typeof details === "object" && "query" in details && typeof details.query === "string") {
        const query = safeSearchQuery(details.query);
        if (query) searchTerms.add(query);
      }
    } else if (productId) {
      if (signal === "PRODUCT_VIEW") viewed.add(productId);
      if ((signal === "WISHLIST_ADD" || signal === "WISHLIST_REMOVE") && !seenWishlist.has(productId)) {
        seenWishlist.add(productId);
        if (signal === "WISHLIST_ADD") wishlisted.add(productId);
      }
      const cartKey = variantId ?? productId;
      if ((signal === "CART_ADD" || signal === "CART_REMOVE" || signal === "CART_UPDATE") && !seenCart.has(cartKey)) {
        seenCart.add(cartKey);
        if (signal !== "CART_REMOVE" && quantity !== 0) carted.add(productId);
      }
    }
  }
  const purchased = new Map<string, Date>();
  for (const order of purchases) for (const { variant } of order.items) {
    if (!purchased.has(variant.productId)) purchased.set(variant.productId, order.createdAt);
  }
  return {
    viewed: [...viewed], carted: [...carted], wishlisted: [...wishlisted], searchTerms: [...searchTerms],
    purchased: [...purchased.keys()],
    repurchaseDue: [...purchased].filter(([, date]) => now - +date >= 14 * day).map(([id]) => id),
  } satisfies RecommendationIntent;
}

