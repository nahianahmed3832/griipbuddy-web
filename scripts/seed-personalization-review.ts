import "./load-env.ts";
import { isDeepStrictEqual } from "node:util";
import { marketIds } from "../src/config/markets.ts";
import { homepageInput, scopeKey } from "../src/lib/catalog/homepage-contract.ts";
import type { RecommendationPolicyOverride } from "../src/lib/catalog/recommendation-policy.ts";
import { getDb } from "../src/lib/db/client.ts";
import { stagingDatabase } from "../src/lib/db/local.ts";
import { marketConfiguration } from "../src/lib/market-config.ts";
import { publishHomepage, saveHomepageRecommendations } from "../src/lib/staff/homepage.ts";

if (process.env.GRIIP_MARKET_REVIEW_FIXTURES !== "1" || !stagingDatabase() ||
    marketIds.some(id => marketConfiguration(id).status !== "staging")) {
  throw new Error("Use the dedicated market review staging database and market profile.");
}

const db = getDb();
try {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { active: true, role: "OWNER" }, select: { userId: true } });
  for (const marketId of marketIds) {
    const scope = { marketId };
    const row = await db.homepageContent.findUniqueOrThrow({ where: { key: scopeKey(scope) }, include: { published: true } });
    const draft = homepageInput.parse(row.draft);
    const published = homepageInput.parse(row.published?.content);
    if (!isDeepStrictEqual(draft, published)) throw new Error(`Publish or restore the existing ${marketId} review draft first.`);
    const policy: RecommendationPolicyOverride = { ...published.recommendations, behavioralEnabled: true,
      placements: {
        ...published.recommendations?.placements,
        recommended: { fallback: marketId === "bd" ? ["p-lamp", "p-rope"] : ["p-speaker", "p-pack"] },
        "buy-again": { replenishable: ["p-notebooks"] },
      },
    };
    if (!isDeepStrictEqual(policy, published.recommendations)) {
      await saveHomepageRecommendations(owner.userId, scope, row.revision, policy);
      await publishHomepage(owner.userId, scope, row.revision + 1);
    }
    console.log(`Personalization review policy available for ${marketId.toUpperCase()} (${marketConfiguration(marketId).currency}).`);
  }
} finally {
  await db.$disconnect();
}
