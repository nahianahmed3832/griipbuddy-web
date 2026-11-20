import { cache } from "react";
import type { MarketId } from "../../config/markets.ts";
import { marketConfiguration } from "../market-config.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { publishedHomepage } from "./homepage-content.ts";
import { resolveRecommendationPolicy, type RecommendationPolicy } from "./recommendation-policy.ts";

export type RecommendationConfig = RecommendationPolicy & { version: string };

export const recommendationConfig = cache(async (marketId: MarketId, locale: string, draftScopeKey?: string): Promise<RecommendationConfig> => {
  const market = marketConfiguration(marketId);
  const { layers, measurement } = await publishedHomepage(marketId, locale, draftScopeKey);
  const policy = resolveRecommendationPolicy(layers.map(layer => layer.recommendations));
  const fingerprint = stableMeasurementId("recommendation-policy-v1", marketId, locale, String(market.revision),
    JSON.stringify(policy), measurement, draftScopeKey ?? "").slice(0, 24);
  return { ...policy, version: `rec-policy-${fingerprint}` };
});
