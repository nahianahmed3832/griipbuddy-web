import assert from "node:assert/strict";
import { test } from "node:test";
import { activeOffer, devOffer, matchedOfferPrice, offerTimerEnd } from "../src/lib/marketplace/dev-offer.ts";

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
