import assert from "node:assert/strict";
import { test } from "node:test";
import { activeOffer, devOffer, devOfferPricing, matchedOfferPrice, offerTimerEnd } from "../src/lib/marketplace/dev-offer.ts";

const subcategoryId = "6a7f48fdf0ee1f53362478bd";
const offer = devOffer.parse({
  offer_start_date: "2026-11-17T00:00:00.000Z", validFor: 7, specialSaleActive: true,
  discountPercentage: 30, freeDelivery: false, applied_subcategories: [{ _id: subcategoryId }],
  pageConf: { timer_config: { show_timer: true, mode: "countdown" } },
});
const start = Date.parse(offer.offer_start_date);
const end = start + 7 * 86_400_000;

test("the dev offer matches the live checkout window and exact subcategory pricing", () => {
  assert.equal(activeOffer(offer, start - 1), null);
  assert.equal(activeOffer(offer, end), null);
  assert.equal(activeOffer({ ...offer, specialSaleActive: false }, start), null);
  const campaign = activeOffer(offer, start);
  assert.ok(campaign);
  const source = { productId: "p-example", subcategoryId, regularMinor: 129950 };
  assert.deepEqual(matchedOfferPrice(campaign, source), {
    amountMinor: 90965, regularMinor: 129950, freeDelivery: false,
  });
  assert.equal(matchedOfferPrice(campaign, { ...source, subcategoryId: "6a7f48acf0ee1f533624786a" }), null);
  assert.equal(matchedOfferPrice({ ...campaign, freeDelivery: true }, source)?.freeDelivery, true);
});

test("the dev countdown uses the active CMS window and respects display settings", () => {
  const campaign = activeOffer(offer, start);
  assert.ok(campaign);
  assert.equal(offerTimerEnd(campaign, start), end);
  assert.equal(offerTimerEnd({ ...campaign, pageConf: { timer_config: { show_timer: false, mode: "countdown" } } }, start), null);
  assert.equal(offerTimerEnd({ ...campaign, pageConf: { timer_config: { show_timer: true, mode: "12h_timer" } } }, start), start + 43_200_000);
  assert.equal(offerTimerEnd({ ...campaign, pageConf: { timer_config: { show_timer: true, mode: "24h_timer" } } }, end - 1), end);
});

test("the checkout reads current published prices only for matching first-party catalog identities", async () => {
  const environment = {
    COMMERCE_MODE: "staging", GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_HYBRID_STOREFRONT: "1",
    BETTER_AUTH_URL: "https://dev.griipbuddy.com", DATABASE_URL: "postgresql://griipbuddy_demo:fixture@db:5432/griipbuddy_hybrid_demo",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const id = "fac000000000000000000001";
    const productId = "p-" + id;
    const variantId = "v-fac000000000000000000002";
    const candidate = { id: variantId, productId, product: { marketplaceShopId: null } };
    const seller = { ...candidate, product: { marketplaceShopId: "third-party" } };
    const mockId = { ...candidate, productId: "p-unmapped", id: "v-unmapped" };
    let regularMinor = 20000;
    const fallback = { amountMinor: 12000, regularMinor: 14000 };
    const fetchPrices: typeof fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://dev.griipbuddy.com");
      assert.equal(url.pathname, "/api/dev-admin-content");
      assert.equal(url.searchParams.get("product_ids"), id);
      return Response.json({ offer, prices: [{ variantId, productId, subcategoryId, regularMinor }] });
    };
    const first = await devOfferPricing("bd", [candidate, seller, mockId], new Date(start), fetchPrices);
    assert.equal(first?.price(candidate, fallback)?.amountMinor, 14000);
    assert.equal(first?.price(seller, fallback), null);
    assert.equal(first?.price(mockId, fallback), null);
    assert.equal(first?.price({ ...candidate, productId: "p-fac000000000000000000003" }, fallback), null);
    regularMinor = 35000;
    const changed = await devOfferPricing("bd", [candidate], new Date(start), fetchPrices);
    assert.equal(changed?.price(candidate, fallback)?.amountMinor, 24500);
    const withdrawn = await devOfferPricing("bd", [candidate], new Date(start), async () => Response.json({ offer, prices: [] }));
    assert.equal(withdrawn?.price(candidate, fallback), null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
