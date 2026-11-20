import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFeedExport, selectFeedItems } from "../src/lib/catalog/merchant-feed-export.ts";
import { merchantFeedXml, type MerchantFeedItem } from "../src/lib/catalog/merchant-feed.ts";
import { fixtureConversionPreview } from "../src/lib/measurement/conversion-preview.ts";
import { stableMeasurementId } from "../src/lib/measurement/domain.ts";
import type { CommerceOutcome } from "../src/lib/measurement/outcomes.ts";

const params = (market: string, currency: string, channel: string, ids: string[], condition?: string) =>
  new URLSearchParams([["market", market], ["currency", currency], ["channel", channel],
    ...ids.map(id => ["variant", id]), ...(condition ? [["condition", condition]] : [])]);
const item = {
  id: "v-new", productId: "p-test", variantId: "v-new", title: "A & B choice", description: "Native test product",
  link: "https://shop.example.invalid/products/test?market=bd&variant=v-new", imageLink: "https://shop.example.invalid/image.webp",
  availability: "out_of_stock", amountMinor: 129900, currency: "BDT", stock: 0, identifierExists: "no",
} satisfies MerchantFeedItem;

test("private catalog downloads bind format, selected variants, market and currency", () => {
  const bd = parseFeedExport(params("bd", "BDT", "google", [item.variantId]));
  assert.ok(bd);
  assert.deepEqual(selectFeedItems([item], bd), [item]);
  assert.equal(selectFeedItems([{ ...item, currency: "USD" }], bd), null);
  assert.equal(selectFeedItems([{ ...item, link: item.link.replace("=bd", "=us") }], bd), null);
  assert.equal(parseFeedExport(params("us", "BDT", "google", [item.variantId])), null);
  assert.equal(parseFeedExport(params("other", "BDT", "google", [item.variantId])), null);
  assert.equal(parseFeedExport(params("bd", "BDT", "google", [item.variantId, item.variantId])), null);
  assert.equal(parseFeedExport(params("bd", "BDT", "google", Array.from({ length: 51 }, (_, i) => `v-${i}`))), null);
  assert.equal(parseFeedExport(params("bd", "BDT", "meta", [item.variantId])), null);
  assert.ok(parseFeedExport(params("bd", "BDT", "meta", [item.variantId], "new")));
  const extra = params("bd", "BDT", "google", [item.variantId]);
  extra.append("target", "https://shop.example.invalid");
  assert.equal(parseFeedExport(extra), null);
});

test("provider XML projects the same escaped eligible offer without inventing Meta condition", () => {
  const settings = { marketId: "bd", origin: "https://shop.example.invalid", regional: false } as const;
  const google = merchantFeedXml([item], settings);
  const meta = merchantFeedXml([item], settings, { metaCondition: "refurbished" });
  for (const xml of [google, meta]) {
    assert.match(xml, /<g:title>A &amp; B choice<\/g:title>/);
    assert.match(xml, /<g:price>1299.00 BDT<\/g:price>/);
    assert.match(xml, /market=bd&amp;variant=v-new/);
  }
  assert.match(google, /<g:availability>out_of_stock<\/g:availability>/);
  assert.match(google, /<g:identifier_exists>no<\/g:identifier_exists>/);
  assert.doesNotMatch(google, /<g:condition>/);
  assert.match(meta, /<g:availability>out of stock<\/g:availability>/);
  assert.match(meta, /<g:condition>refurbished<\/g:condition>/);
});

test("minimum-data conversion preview is stable and requires consented committed test evidence", () => {
  const capture: CommerceOutcome = {
    id: stableMeasurementId("PAYMENT_PAID", "order-synthetic"), schemaVersion: 1, kind: "PAYMENT_PAID",
    at: new Date("2026-11-01T12:00:00.000Z"), marketId: "us", currency: "USD", amountMinor: 3000,
    journeyId: "consent-private", sessionId: "session-private", orderId: "order-private",
    transactionId: `gb-${"a".repeat(40)}`, test: true, evidence: "sandbox", source: "payment", paymentMethod: "PAYPAL",
    purchaseLines: [{ productId: "p-private", variantId: "v-private", offerId: "offer-private", quantity: 1 }],
  };
  const preview = fixtureConversionPreview(capture, "us");
  assert.deepEqual(preview, { version: 1, eventId: capture.id, transaction: capture.transactionId,
    event: "payment_captured", occurredAt: "2026-11-01T12:00:00.000Z", market: "us", currency: "USD", amountMinor: 3000 });
  assert.deepEqual(fixtureConversionPreview({ ...capture }, "us"), preview);
  assert.doesNotMatch(JSON.stringify(preview), /private|paymentMethod|purchaseLines|journey|session/);
  assert.equal(fixtureConversionPreview({ ...capture, journeyId: null }, "us"), null);
  assert.equal(fixtureConversionPreview({ ...capture, test: false }, "us"), null);
  assert.equal(fixtureConversionPreview(capture, "bd"), null);
  assert.equal(fixtureConversionPreview({ ...capture, kind: "ORDER_ACCEPTED" }, "us"), null);
  assert.equal(fixtureConversionPreview({ ...capture, kind: "COD_REMITTED", paymentMethod: "COD" }, "us"), null);
  assert.equal(fixtureConversionPreview({ ...capture, evidence: "unknown" }, "us"), null);
  assert.equal(fixtureConversionPreview({ ...capture, kind: "COD_COLLECTED", paymentMethod: "COD", marketId: "bd",
    currency: "BDT", evidence: "fixture" }, "bd")?.event, "cash_collected");
});
