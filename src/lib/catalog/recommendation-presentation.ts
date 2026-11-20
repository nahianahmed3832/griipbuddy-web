import type { ProductCardData } from "./listing";

export const privateHomepagePlacements = ["recommended", "continue", "buy-again"] as const;
export type PrivateHomepagePlacement = typeof privateHomepagePlacements[number];

export type RecommendationRow = {
  cards: ProductCardData[];
  version: string;
  configurationVersion: string;
  personalized: boolean;
  showFeatured?: boolean;
  assignment?: { id: string; experimentId: string; variant: "control" | "personalized" };
};

export type HomepageRecommendationRows = Partial<Record<PrivateHomepagePlacement, RecommendationRow>>;
