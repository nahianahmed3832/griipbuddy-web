import { z } from "zod";

export const recommendationPlacements = ["recommended", "continue", "similar", "complementary", "bestsellers", "trending", "buy-again"] as const;
export const recommendationStrategies = ["curated", "behavioral", "attributes", "co-purchase", "popularity", "history"] as const;
export type RecommendationPlacement = typeof recommendationPlacements[number];
export type RecommendationStrategy = typeof recommendationStrategies[number];

export const recommendationPlacementStrategies: Record<RecommendationPlacement, readonly RecommendationStrategy[]> = {
  recommended: ["behavioral", "curated", "history", "popularity"],
  continue: ["history", "behavioral"],
  similar: ["attributes", "curated"],
  complementary: ["co-purchase", "attributes", "curated"],
  bestsellers: ["popularity", "curated"],
  trending: ["popularity", "curated"],
  "buy-again": ["history", "behavioral"],
};

export const recommendationPlacementLabels: Record<RecommendationPlacement, string> = {
  recommended: "Recommended for you",
  continue: "Continue browsing",
  similar: "Similar products",
  complementary: "Complementary products",
  bestsellers: "Market bestsellers",
  trending: "Trending in your market",
  "buy-again": "Buy again",
};

export const recommendationStrategyLabels: Record<RecommendationStrategy, string> = {
  curated: "Curated",
  behavioral: "Shopping intent",
  attributes: "Product attributes",
  "co-purchase": "Complementary products",
  popularity: "Market demand",
  history: "Shopping history",
};

export const recommendationProductId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const products = z.array(recommendationProductId).max(24).transform(ids => [...new Set(ids)]);
const placementOverride = z.strictObject({
  enabled: z.boolean().optional(),
  strategy: z.enum(recommendationStrategies).optional(),
  boosts: products.optional(),
  excludes: products.optional(),
  fallback: products.optional(),
  replenishable: products.optional(),
});

export const recommendationPolicyInput = z.strictObject({
  behavioralEnabled: z.boolean().optional(),
  placements: z.partialRecord(z.enum(recommendationPlacements), placementOverride).optional(),
}).superRefine(({ placements }, ctx) => {
  if (!placements) return;
  for (const placement of recommendationPlacements) {
    const override = placements[placement];
    if (override?.strategy && !recommendationPlacementStrategies[placement].includes(override.strategy)) {
      ctx.addIssue({ code: "custom", path: ["placements", placement, "strategy"], message: "Choose a strategy supported by this placement." });
    }
    if (placement !== "buy-again" && override?.replenishable !== undefined) {
      ctx.addIssue({ code: "custom", path: ["placements", placement, "replenishable"], message: "Configure replenishable products in Buy again." });
    }
  }
});

export type RecommendationPolicyOverride = z.infer<typeof recommendationPolicyInput>;
export type RecommendationPlacementPolicy = Required<z.infer<typeof placementOverride>> & {
  configured: boolean;
  fallbackConfigured: boolean;
};
export type RecommendationPolicy = {
  behavioralEnabled: boolean;
  placements: Record<RecommendationPlacement, RecommendationPlacementPolicy>;
};

function placement(strategy: RecommendationStrategy): RecommendationPlacementPolicy {
  return { enabled: true, strategy, boosts: [], excludes: [], fallback: [], replenishable: [], configured: false, fallbackConfigured: false };
}

function defaultRecommendationPolicy(): RecommendationPolicy {
  return {
    behavioralEnabled: false,
    placements: {
      recommended: placement("behavioral"),
      continue: placement("history"),
      similar: placement("attributes"),
      complementary: placement("co-purchase"),
      bestsellers: placement("popularity"),
      trending: placement("popularity"),
      "buy-again": placement("history"),
    },
  };
}

export function resolveRecommendationPolicy(layers: readonly (RecommendationPolicyOverride | undefined)[]): RecommendationPolicy {
  const effective = defaultRecommendationPolicy();
  for (const layer of layers) {
    if (!layer) continue;
    effective.behavioralEnabled = layer.behavioralEnabled ?? effective.behavioralEnabled;
    for (const key of recommendationPlacements) {
      const override = layer.placements?.[key];
      if (override && Object.keys(override).length) {
        const inherited = effective.placements[key];
        effective.placements[key] = {
          ...inherited, ...override, configured: true,
          fallbackConfigured: override.fallback !== undefined || inherited.fallbackConfigured,
        };
      }
    }
  }
  return effective;
}
