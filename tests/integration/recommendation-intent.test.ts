import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { config } from "dotenv";
import { shopperRecommendationIntent } from "../../src/lib/catalog/recommendation-intent.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { stableMeasurementId } from "../../src/lib/measurement/domain.ts";
import { measurementAccountKey } from "../../src/lib/measurement/server.ts";
import type { MeasurementKind } from "../../src/generated/prisma/client.ts";

config({ path: ".env.test", override: true, quiet: true });
requireLocalDatabase("griipbuddy_test");
const db = getDb();
test.after(() => db.$disconnect());

test("shopper intent limits anonymous handoff to its consent, owner, journey and market", async () => {
  const shopperId = randomUUID();
  const shopperKey = measurementAccountKey(shopperId);
  const otherKey = measurementAccountKey(randomUUID());
  const journeyId = stableMeasurementId("recommendation-intent-test", shopperId);
  const otherJourney = stableMeasurementId("recommendation-intent-test-other", shopperId);
  const t = (minute: number) => new Date(Date.UTC(2025, 5, 1) + minute * 60_000);
  const preference = { journeyId, shopperId, shopperKey, associatedAt: t(20), since: t(10), enabled: true, blocked: false };
  const event = (productId: string, minute: number, accountKey: string | null = null, marketId: "bd" | "us" = "bd",
    kind: MeasurementKind = "PRODUCT_VIEW", inJourney = journeyId) => ({
    id: stableMeasurementId(inJourney, productId, String(minute)), journeyId: inJourney, kind,
    productId, accountKey, marketId, at: t(minute), receivedAt: t(minute),
  });
  try {
    await db.shopper.create({ data: { id: shopperId, email: `${shopperId}@example.test`, name: "Recommendation QA" } });
    await db.measurementJourney.createMany({ data: [journeyId, otherJourney].map(id => ({
      id, test: true, grantedAt: t(0), expiresAt: t(400),
    })) });
    await db.measurementEvent.createMany({ data: [
      event("pre-consent", 9), event("anonymous-first", 11),
      event("anonymous-before-signin", 19), event("anonymous-after-signout", 23),
      { ...event("backdated-after-signout", 18), receivedAt: t(23) },
      event("other-owner", 24, otherKey), event("current-owner", 25, shopperKey),
      event("other-journey", 26, shopperKey, "bd", "PRODUCT_VIEW", otherJourney),
      event("other-market", 27, shopperKey, "us"),
      event("removed-wishlist", 28, shopperKey, "bd", "WISHLIST_ADD"),
      event("removed-wishlist", 29, shopperKey, "bd", "WISHLIST_REMOVE"),
      event("current-wishlist", 30, shopperKey, "bd", "WISHLIST_ADD"),
      event("removed-cart", 31, shopperKey, "bd", "CART_ADD"),
      event("removed-cart", 32, shopperKey, "bd", "CART_REMOVE"),
      event("current-cart", 33, shopperKey, "bd", "CART_ADD"),
      event("after-query", 54, shopperKey),
      { ...event("search-product", 34, shopperKey, "bd", "SEARCH"), details: { query: "wireless case" } },
      { ...event("unsafe-search", 35, shopperKey, "bd", "SEARCH"), details: { query: "person@example.test" } },
    ] });
    const bd = await shopperRecommendationIntent(preference, "bd", "BDT", t(50));
    assert.deepEqual(bd.viewed, ["current-owner", "anonymous-before-signin", "anonymous-first"]);
    assert.deepEqual(bd.wishlisted, ["current-wishlist"]);
    assert.deepEqual(bd.carted, ["current-cart"]);
    assert.deepEqual(bd.searchTerms, ["wireless case"]);
    assert.deepEqual((await shopperRecommendationIntent(preference, "us", "USD", t(50))).viewed, ["other-market"]);
    assert.deepEqual(await shopperRecommendationIntent({ ...preference, enabled: false }, "bd", "BDT", t(50)), {});
    await db.recommendationAccountReset.create({ data: { shopperId, since: t(30) } });
    const reset = await shopperRecommendationIntent(preference, "bd", "BDT", t(50));
    assert.deepEqual(reset.viewed, []);
    assert.deepEqual(reset.wishlisted, ["current-wishlist"]);
  } finally {
    await db.measurementJourney.deleteMany({ where: { id: { in: [journeyId, otherJourney] } } });
    await db.shopper.deleteMany({ where: { id: shopperId } });
  }
});
