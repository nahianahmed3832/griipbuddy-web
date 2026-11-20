import assert from "node:assert/strict";
import { test } from "node:test";
import { acquisitionCampaign, acquisitionDestination, campaignLabel, publicCampaignFields } from "../src/lib/measurement/campaign.ts";
import { acquisitionActivationBlockers } from "../src/lib/measurement/activation.ts";
import { cohort, cohortWindow, eligiblePath, ga4BookedOrder, majorUnits, projectedOrderEvents, type CommerceMeasurementRow } from "../src/lib/measurement/domain.ts";

const now = new Date("2026-11-14T12:00:00Z");

test("campaign accepts only the exact public tags and drops unrelated browser fields", () => {
  const landing = new URL(acquisitionDestination);
  landing.searchParams.set("email", "private@example.test");
  landing.searchParams.set("order_access", "never-export");
  const campaign = publicCampaignFields(landing.search);
  assert.deepEqual(campaign, acquisitionCampaign.utm);
  assert.equal(campaignLabel(campaign), acquisitionCampaign.label);
  landing.searchParams.append("utm_source", "other");
  assert.equal(publicCampaignFields(landing.search), undefined);
  assert.equal(campaignLabel({ ...acquisitionCampaign.utm, utm_campaign: "private@example.test" }), null);
});

test("report counts in-sequence product journeys and uses Dhaka date boundaries", () => {
  const events = [
    { id: "1", at: new Date(+now - 5_000), kind: "CART_ADD" as const, variantId: "sku-1", campaign: null },
    { id: "2", at: new Date(+now - 4_000), kind: "PRODUCT_VIEW" as const, variantId: "sku-1", campaign: null },
    { id: "3", at: new Date(+now - 3_000), kind: "CHECKOUT_START" as const, variantId: null, campaign: null },
    { id: "4", at: new Date(+now - 2_000), kind: "CART_ADD" as const, variantId: "sku-2", campaign: null },
    { id: "5", at: new Date(+now - 1_000), kind: "CHECKOUT_START" as const, variantId: null, campaign: null },
  ];
  assert.equal(cohort(events)?.cart?.id, "4");
  assert.equal(cohort(events)?.checkout?.id, "5");
  const order = { ...sampleOrder(), createdAt: now };
  assert.equal(eligiblePath(events, order), null);
  assert.ok(eligiblePath(events, { ...order, items: [{ ...order.items[0], variantId: "sku-2" }] }));
  const period = cohortWindow(new Date("2026-11-14T18:00:01Z"), "2026-11-15", "2026-11-15");
  assert.equal(period.fromAt.toISOString(), "2026-11-14T18:00:00.000Z");
  assert.equal(period.to, "2026-11-15");
});

function sampleOrder(): CommerceMeasurementRow {
  return {
    id: "6fedad99-c9cd-4a36-9b63-dfcc8daaefdf", marketId: "bd", currency: "BDT", measurementTest: true,
    createdAt: new Date(+now - 1000), cancelledAt: null, fulfillmentStatus: "UNFULFILLED",
    totalMinor: 18555, subtotalMinor: 12010, discountMinor: 155, taxMinor: 700, deliveryMinor: 6000,
    items: [{ variantId: "sku-1", unitPriceMinor: 12010, unitDiscountMinor: 155, quantity: 1 }],
    payment: { method: "COD", status: "AWAITING_COLLECTION", currency: "BDT", amountMinor: 18555, collectedAt: null },
  };
}

test("GA4 purchase preview uses booked merchandise units and stable, noncustomer transaction IDs", () => {
  const order = { ...sampleOrder(), customerName: "Private name", email: "private@example.test",
    guestToken: "private-guest", phone: "012345", landingPage: "https://example.test/orders?guest=private" };
  assert.equal(ga4BookedOrder(order, now), null);
  const payload = ga4BookedOrder(order, now, true)!;
  assert.deepEqual(payload.params.items, [{ item_id: "sku-1", price: 118.55, discount: 1.55, quantity: 1 }]);
  assert.equal(payload.params.currency, "BDT");
  assert.equal(payload.params.value, 118.55);
  assert.equal(payload.params.tax, 7);
  assert.equal(payload.params.shipping, 60);
  assert.equal(majorUnits(12345, "USD"), 123.45);
  assert.throws(() => majorUnits(-1, "BDT"), /Invalid/);
  assert.match(payload.params.transaction_id, /^gb-[a-f0-9]{40}$/);
  assert.doesNotMatch(JSON.stringify(payload), /private|guest|email|phone|page_location|page_referrer|6fedad99/i);
  const pending = projectedOrderEvents(order, now);
  assert.deepEqual(pending.map(event => event.kind), ["ORDER_ACCEPTED"]);
  const collected = { ...order, payment: { ...order.payment!, collectedAt: now, status: "COLLECTED" as const } };
  assert.deepEqual(projectedOrderEvents(collected, now).map(event => event.kind), ["ORDER_ACCEPTED", "COD_COLLECTED"]);
  assert.deepEqual(projectedOrderEvents(collected, now), projectedOrderEvents(collected, now));
  assert.deepEqual(ga4BookedOrder(collected, now, true), payload);
});

test("experiment guard rejects missing spending approval, invalid destinations and missing live proof", () => {
  const approved = {
    ownerApproved: true, campaign: acquisitionCampaign.label, account: "act_1410454054233870",
    currency: "USD", limitMinor: 2500, start: "2026-11-15T00:00:00+06:00", end: "2026-11-22T00:00:00+06:00",
  };
  const verified = {
    now, authorization: approved, destination: acquisitionDestination, approvedContent: true, verifiedGeography: true,
    verifiedLiveOrderMatching: true, pausedObjectsVerified: true,
    observed: { finalUrl: acquisitionDestination, publicStatus: 200, productId: acquisitionCampaign.productId,
      variantId: acquisitionCampaign.variantId, currency: "BDT", priceMinor: 15000, available: 23 },
  };
  assert.deepEqual(acquisitionActivationBlockers(verified), []);
  assert.match(acquisitionActivationBlockers({ ...verified, authorization: undefined }).join(" "), /total USD spend/);
  assert.match(acquisitionActivationBlockers({ ...verified, destination: "https://example.com" }).join(" "), /exact public landing page/);
  assert.match(acquisitionActivationBlockers({ ...verified, verifiedLiveOrderMatching: false }).join(" "), /checkout-to-order matching/);
  assert.match(acquisitionActivationBlockers({ ...verified, authorization: { ...approved, end: approved.start } }).join(" "), /seven-day schedule/);
});
