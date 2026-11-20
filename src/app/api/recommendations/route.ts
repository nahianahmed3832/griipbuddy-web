import { after, NextResponse } from "next/server";
import { z } from "zod";
import { recommendationConfig } from "@/lib/catalog/recommendation-config";
import { recommendationExperimentAssignment, recordRecommendationExperimentLatency, verifyFeaturedPlacementProof } from "@/lib/catalog/recommendation-experiment";
import { productCards } from "@/lib/catalog/listing";
import { privateHomepagePlacements, type HomepageRecommendationRows, type RecommendationRow } from "@/lib/catalog/recommendation-presentation";
import { loadRecommendations } from "@/lib/catalog/recommendations";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { measurementSessionHeader } from "@/lib/measurement/server";

const productIds = z.array(z.string().min(1).max(160)).max(256);
const input = z.object({
  marketId: z.string().min(1).max(30),
  locale: z.string().min(1).max(30),
  placements: z.array(z.enum(privateHomepagePlacements)).min(1).max(privateHomepagePlacements.length),
  excludeProductIds: productIds,
  featuredProductIds: productIds,
  featuredProof: z.string().max(75).optional(),
}).strict();

export async function POST(request: Request) {
  const reply = (rows: HomepageRecommendationRows, status = 200) => NextResponse.json({ rows }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return reply({}, 403);
  const parsed = input.safeParse(await readJson(request, 49_152));
  if (!parsed.success) return reply({}, 400);
  const { marketId, locale, placements, excludeProductIds, featuredProductIds, featuredProof } = parsed.data;
  const market = await currentMarket();
  if (marketId !== market.id || locale !== market.locale) return reply({}, 409);

  try {
    const started = performance.now();
    const config = await recommendationConfig(market.id, market.locale);
    const rows: HomepageRecommendationRows = {};
    const used = new Set(excludeProductIds);
    for (const placement of privateHomepagePlacements) {
      if (!placements.includes(placement) || !config.placements[placement].enabled) continue;
      const experimentalSlot = placement === "recommended" && config.behavioralEnabled && verifyFeaturedPlacementProof(
        { marketId: market.id, locale: market.locale, version: config.version, productIds: featuredProductIds }, featuredProof);
      const assignment = experimentalSlot ? await recommendationExperimentAssignment(market.id, request).catch(error => {
        reportFailure("recommendations.assignment", undefined, error);
        return null;
      }) : null;
      const finish = (row: RecommendationRow) => {
        rows[placement] = row;
        for (const id of row.showFeatured ? featuredProductIds : row.cards.map(card => card.id)) used.add(id);
      };
      try {
        if (assignment?.variant === "control") {
          finish({ cards: [], showFeatured: true, personalized: false, version: "featured-v1", configurationVersion: config.version, assignment });
          continue;
        }
        const allowBehavioral = request.headers.has(measurementSessionHeader);
        if (!allowBehavioral && placement !== "recommended") continue;
        const result = await loadRecommendations({ marketId: market.id, locale: market.locale, placement, config, request,
          allowBehavioral, excludeProductIds: [...used], limit: placement === "recommended" ? 6 : 4 });
        const cards = productCards(result.items.map(item => item.product));
        const personalized = ["behavioral", "history"].includes(result.strategy);
        const showFeatured = placement === "recommended" && Boolean(featuredProductIds.length) &&
          (!cards.length || !assignment && !personalized && !config.placements.recommended.configured);
        finish({ cards: showFeatured ? [] : cards, showFeatured, personalized, version: showFeatured ? "featured-v1" : result.version,
          configurationVersion: result.configurationVersion, assignment: assignment ?? undefined });
      } catch (error) {
        reportFailure("recommendations.placement", undefined, error);
        if (placement === "recommended" && featuredProductIds.length) {
          finish({ cards: [], showFeatured: true, personalized: false, version: "featured-v1", configurationVersion: config.version,
            assignment: assignment ?? undefined });
        }
      } finally {
        if (assignment) {
          const elapsed = performance.now() - started;
          after(async () => {
            try { await recordRecommendationExperimentLatency(assignment.id, elapsed); }
            catch (error) { reportFailure("recommendations.latency", undefined, error); }
          });
        }
      }
    }
    return reply(rows);
  } catch (error) {
    reportFailure("recommendations.homepage", undefined, error);
    return reply({}, 503);
  }
}
