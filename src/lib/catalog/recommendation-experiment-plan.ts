import type { MarketId } from "../../config/markets.ts";
import { stableMeasurementId } from "../measurement/domain.ts";

// Changes to the treatment, endpoints or assignment unit require a new plan ID.
export const recommendationExperimentPlan = {
  id: "homepage-recommendations-v1",
  placement: "recommended",
  control: "the existing editorial Featured picks",
  personalized: "permitted shopping history with contextual or editorial fallback when needed",
  allocation: 0.5,
  bookingDays: 7,
  collectionDays: 14,
  fulfillmentDays: 21,
  minMaturePerArm: 1_000,
  minCompletedPerArm: 20,
} as const;

export type RecommendationExperimentArm = "control" | "personalized";
export type RecommendationExperiment = {
  id: string;
  experimentId: typeof recommendationExperimentPlan.id;
  variant: RecommendationExperimentArm;
};

export function recommendationExperimentVariant(marketId: MarketId, journeyId: string): RecommendationExperimentArm {
  // The journey is itself an opaque, randomly generated measurement identifier.
  const hash = stableMeasurementId("experiment-bucket", recommendationExperimentPlan.id, marketId, journeyId);
  const fraction = Number.parseInt(hash.slice(0, 8), 16) / 0x100000000;
  return fraction < recommendationExperimentPlan.allocation ? "control" : "personalized";
}
