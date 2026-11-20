import { cache } from "react";
import type { MarketId } from "../../config/markets.ts";
import { marketHasDelivery } from "../commerce/orders.ts";
import { getDb } from "../db/client.ts";
import { marketConfiguration, isMarketSelectable } from "../market-config.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { productionMode } from "../release-config.ts";
import { homepageDemand } from "./homepage-demand.ts";
import { recommendationConfig, type RecommendationConfig } from "./recommendation-config.ts";
import type { RecommendationPlacement, RecommendationStrategy } from "./recommendation-policy.ts";
import { shopperRecommendationIntent } from "./recommendation-intent.ts";
import { getRecommendationPreference } from "./recommendation-preferences.ts";
import { eligibleRecommendationProduct, rankRecommendations, type RecommendationIntent, type RecommendationItem } from "./recommendation-rules.ts";
import { catalog } from "./repository.ts";

export { recommendationReasonLabels, type RecommendationReason } from "./recommendation-rules.ts";
export type { RecommendationIntent } from "./recommendation-rules.ts";

const day = 86_400_000;
const noDemand = { bestsellers: [], trending: [] };
const noIntent: RecommendationIntent = {};


export type RecommendationResult = {
  placement: RecommendationPlacement;
  enabled: boolean;
  configurationVersion: string;
  strategy: RecommendationStrategy;
  version: string;
  items: RecommendationItem[];
};


const candidatesForMarket = async (marketId: MarketId) => {
  if (!await marketHasDelivery(marketId)) return [];
  const market = marketConfiguration(marketId);
  return (await catalog.listProducts({ marketId })).flatMap(product => eligibleRecommendationProduct(product, market, productionMode()) ?? []);
};
const requestCatalog = cache((marketId: MarketId, locale: string, configurationVersion: string) =>
  configurationVersion && marketConfiguration(marketId).languages.includes(locale) ? candidatesForMarket(marketId) : []);

type RequestData = { candidates?: ReturnType<typeof candidatesForMarket>; intent?: ReturnType<typeof shopperRecommendationIntent> };
const responseData = new WeakMap<Request, Map<string, RequestData>>();
function withinRequest(request: Request, marketId: MarketId, locale: string, configurationVersion: string) {
  let data = responseData.get(request);
  if (!data) {
    data = new Map();
    responseData.set(request, data);
  }
  const key = JSON.stringify([marketId, locale, configurationVersion]);
  let entry = data.get(key);
  if (!entry) {
    entry = {};
    data.set(key, entry);
  }
  return entry;
}

async function complementaryDemand(marketId: MarketId, anchor: string) {
  const rows = await getDb().$queryRaw<{ id: string }[]>`
    SELECT v."productId" AS id
    FROM "Order" o
    JOIN "Payment" p ON p."orderId" = o.id
    JOIN "OrderItem" i ON i."orderId" = o.id
    JOIN "Variant" v ON v.id = i."variantId"
    WHERE o."marketId" = ${marketId}::"MarketCode" AND o."measurementTest" = false
      AND o.status = 'PLACED' AND o."fulfillmentStatus" = 'DELIVERED' AND p.status IN ('COLLECTED', 'PAID')
      AND o."createdAt" >= ${new Date(Date.now() - 90 * day)}
      AND v."productId" <> ${anchor}
      AND EXISTS (
        SELECT 1 FROM "OrderItem" a JOIN "Variant" va ON va.id = a."variantId"
        WHERE a."orderId" = o.id AND va."productId" = ${anchor}
      )
    GROUP BY v."productId"
    HAVING COUNT(DISTINCT o.id) >= 3
    ORDER BY COUNT(DISTINCT o.id) DESC, v."productId"
    LIMIT 50
  `;
  return rows.map(row => row.id);
}

export async function loadRecommendations({
  marketId, locale, placement, anchorProductId, config, allowBehavioral = false, syntheticIntent,
  request, excludeProductIds = [], limit = 6, asOf = new Date(),
}: {
  marketId: MarketId;
  locale: string;
  placement: RecommendationPlacement;
  anchorProductId?: string;
  config?: RecommendationConfig;
  allowBehavioral?: boolean;
  syntheticIntent?: RecommendationIntent;
  request?: Request;
  excludeProductIds?: readonly string[];
  limit?: number;
  asOf?: Date;
}): Promise<RecommendationResult> {
  const market = marketConfiguration(marketId);
  const publication = config ?? await recommendationConfig(marketId, locale);
  const policy = publication.placements[placement];
  const version = `rules-v1-${stableMeasurementId(marketId, locale, String(market.revision), publication.version, placement, JSON.stringify(policy)).slice(0, 24)}`;
  const enabled = isMarketSelectable(marketId) && market.languages.includes(locale) && policy.enabled;
  const meta = { placement, version, enabled, configurationVersion: publication.version };
  if (!enabled) return { ...meta, strategy: policy.strategy, items: [] };
  const behavioralPolicy = policy.strategy === "behavioral" || policy.strategy === "history";
  const consultIntent = behavioralPolicy && publication.behavioralEnabled && allowBehavioral;
  const needsDemand = policy.strategy === "popularity" || placement === "recommended" && policy.strategy !== "curated";
  const scope = request && withinRequest(request, marketId, locale, publication.version);
  const getIntent = (): Promise<RecommendationIntent> => getRecommendationPreference(request).then(preference =>
    shopperRecommendationIntent(preference, marketId, market.currency));
  const [products, categories, demand, coPurchased, intent] = await Promise.all([
    scope ? scope.candidates ??= candidatesForMarket(marketId) : requestCatalog(marketId, locale, publication.version),
    placement === "recommended" || placement === "complementary" ? catalog.listDepartments(marketId) : [],
    needsDemand ? homepageDemand(marketId, asOf) : noDemand,
    placement === "complementary" && policy.strategy === "co-purchase" && anchorProductId ? complementaryDemand(marketId, anchorProductId) : [],
    consultIntent ? syntheticIntent ?? (scope ? scope.intent ??= getIntent() : getIntent()) : noIntent,
  ]);
  const items = rankRecommendations({
    products, departments: new Map(categories.map(department => [department.id, department])), policy, placement, intent,
    demand, coPurchased, anchorProductId, excludeProductIds: excludeProductIds.slice(0, 512),
    limit: Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 16)) : 6,
  });
  const personalReasons = ["recently-viewed", "search-match", "saved-intent", "cart-intent", "related-to-view", "replenishable-purchase"];
  const usedBehavior = items.some(item => personalReasons.includes(item.reason)) || Boolean(intent.purchased?.length);
  return { ...meta, strategy: behavioralPolicy && !usedBehavior ? "curated" : policy.strategy, items };
}
