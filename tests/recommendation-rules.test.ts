import assert from "node:assert/strict";
import test from "node:test";
import { toCard } from "../src/lib/catalog/listing.ts";
import { resolveRecommendationPolicy } from "../src/lib/catalog/recommendation-policy.ts";
import { eligibleRecommendationProduct, rankRecommendations } from "../src/lib/catalog/recommendation-rules.ts";
import type { CatalogProduct, Department, MarketOffer } from "../src/lib/catalog/types.ts";

const image = { src: "/editorial/hero.webp", alt: "Fixture" };
const market = { id: "bd", currency: "BDT" } as const;
const demand = { bestsellers: [], trending: [] };
const departments = new Map<string, Department>([
  ["cases", { id: "cases", slug: "phone-cases", name: "Phone cases", shortName: "Cases", description: "", image }],
  ["protectors", { id: "protectors", slug: "screen-protectors", name: "Screen protectors", shortName: "Protectors", description: "", image }],
]);
const defaultPolicies = resolveRecommendationPolicy([]).placements;

function product(id: string, departmentId = "cases", options: Partial<CatalogProduct> = {}): CatalogProduct {
  return { id, name: id, slug: id, departmentId, description: "", keywords: [], specifications: [], images: [image],
    addedOn: "2026-11-01", variants: [{ id, options: {}, offer: { variantId: id, marketId: "bd", currency: "BDT", amountMinor: 1200, stock: 3 } }],
    ...options,
  };
}

test("recommendation cards expose only eligible, stocked offers in the selected currency", () => {
  const variant = (id: string, offer: Omit<MarketOffer, "variantId">) => ({ id, options: {}, offer: { ...offer, variantId: id } });
  const item = product("case", "cases", { variants: [
    variant("foreign", { marketId: "us", currency: "USD", amountMinor: 400, stock: 20 }),
    variant("wrong-currency", { marketId: "bd", currency: "USD", amountMinor: 100, stock: 20 }),
    variant("sold-out", { marketId: "bd", currency: "BDT", amountMinor: 25, stock: 0 }),
    variant("bd", { marketId: "bd", currency: "BDT", amountMinor: 1200, stock: 2 }),
  ] });
  const local = eligibleRecommendationProduct(item, market, false);
  assert.ok(local);
  assert.deepEqual(local.variants.map(row => row.id), ["bd"]);
  assert.equal(toCard(local)?.priceMinor, 1200);
  assert.equal(eligibleRecommendationProduct(product("only-bd"), { id: "us", currency: "USD" }, false), null);
  assert.equal(eligibleRecommendationProduct({ ...item, demo: true }, market, true), null);
});

test("recent cart intent lifts relevant products and excludes durable purchases and repeated IDs", () => {
  const ranked = rankRecommendations({
    products: [
      product("case-in-cart", "cases", { keywords: ["iphone 16 pro"] }),
      product("case-alternative", "cases", { keywords: ["iphone 16 pro"] }),
      product("case-incompatible", "cases", { keywords: ["iphone 16 pro max"] }),
      product("already-bought"), product("excluded"), product("water-bottle", "outdoors"), product("water-bottle", "outdoors"),
    ],
    departments, placement: "recommended", policy: defaultPolicies.recommended, demand, limit: 6,
    intent: { carted: ["case-in-cart"], purchased: ["already-bought"], searchTerms: ["water bottle"] },
    excludeProductIds: ["excluded"],
  });
  assert.deepEqual(ranked.slice(0, 2).map(row => [row.productId, row.reason]), [
    ["case-alternative", "cart-intent"], ["case-in-cart", "cart-intent"],
  ]);
  assert.equal(ranked.find(row => row.productId === "water-bottle")?.reason, "search-match");
  assert.equal(ranked.find(row => row.productId === "case-incompatible")?.reason, "catalog-discovery");
  assert.equal(ranked.filter(row => row.productId === "water-bottle").length, 1);
  assert.ok(ranked.every(row => row.productId !== "already-bought" && row.productId !== "excluded"));
});

test("known incompatible complements are suppressed even if configured or often co-purchased", () => {
  const ranked = rankRecommendations({
    products: [
      product("anchor", "cases", { keywords: ["iphone 16 pro", "add-on:mismatch"] }),
      product("compatible", "protectors", { keywords: ["iphone 16 pro"] }),
      product("mismatch", "protectors", { keywords: ["iphone 16 pro max"] }),
      product("unrelated", "sports"),
    ],
    departments, placement: "complementary", policy: defaultPolicies.complementary, demand, limit: 6,
    anchorProductId: "anchor", coPurchased: ["mismatch"],
  });
  assert.deepEqual(ranked.map(row => [row.productId, row.reason]), [["compatible", "compatible-complement"]]);
});

test("history slots need matching activity and buy-again needs an explicit replenishable product", () => {
  const input = { products: [product("refill"), product("durable"), product("new-order")], departments, demand, limit: 6 };
  assert.deepEqual(rankRecommendations({ ...input, placement: "continue", policy: defaultPolicies.continue }), []);
  const policy = { ...defaultPolicies["buy-again"], replenishable: ["refill", "new-order"] };
  const buyAgain = rankRecommendations({
    ...input, placement: "buy-again", policy,
    intent: { purchased: ["refill", "durable", "new-order"], repurchaseDue: ["refill", "durable"] },
  });
  assert.deepEqual(buyAgain.map(row => [row.productId, row.reason]), [["refill", "replenishable-purchase"]]);
});

test("curated items in a popularity slot keep their curated reason when evidence is absent", () => {
  const input = {
    products: [product("evidenced"), product("curated"), product("featured", "cases", { featured: true })], departments, limit: 6,
    placement: "trending" as const, policy: { ...defaultPolicies.trending, fallback: ["curated"] },
  };
  assert.deepEqual(rankRecommendations({ ...input, demand }).map(row => [row.productId, row.reason]), [
    ["curated", "curated"], ["featured", "curated"],
  ]);
  assert.equal(rankRecommendations({ ...input, demand: { ...demand, trending: ["evidenced"] } })[0]?.reason, "market-trending");
});

test("a recommended lineup limits repetitive categories and sellers", () => {
  const shop = (id: string) => ({ id, slug: id, name: id });
  const products = Array.from({ length: 7 }, (_, index) => product(`item${index}`, index < 5 ? "cases" : "outdoors", {
    shop: shop(index < 5 ? "store-a" : "store-b"),
  }));
  const ranked = rankRecommendations({
    products, departments, demand, placement: "recommended", policy: defaultPolicies.recommended, limit: 4,
  });
  assert.equal(ranked.length, 4);
  assert.equal(ranked.filter(row => row.product.shop?.id === "store-a").length, 2);
  assert.equal(ranked.filter(row => row.product.departmentId === "cases").length, 2);
});
