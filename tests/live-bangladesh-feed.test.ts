import assert from "node:assert/strict";
import test from "node:test";
import { refreshBangladeshMerchantItems } from "../src/lib/catalog/live-bangladesh-feed.ts";
import { merchantBdPreviewPageProduct, merchantBdPreviewRobotsPaths, refreshDevBangladeshMerchantItems } from "../src/lib/catalog/merchant-bd-preview.ts";
import type { MerchantFeedItem, MerchantFeedSettings } from "../src/lib/catalog/merchant-feed.ts";
import type { CatalogProduct } from "../src/lib/catalog/types.ts";

const productId = "6a2160b7c91498b77bdeb4de";
const variantId = "6a2160b7c91498b77bdeb4e0";
const categoryId = "6a7fdc00f0ee1f5336249a78";
const slug = "memo-cx08-magnetic-phone-cooler-15w-99a742";
const item: MerchantFeedItem = {
  id: `v-${variantId}`, variantId: `v-${variantId}`, productId: `p-${productId}`, title: "MEMO CX08", description: "15W phone cooler",
  link: `https://dev.griipbuddy.com/bd/products/${slug}?market=bd&variant=v-${variantId}`,
  imageLink: "https://dev.griipbuddy.com/media/cx08", brand: "MEMO", mpn: "CX08",
  currency: "BDT", amountMinor: 330000, stock: 9, availability: "in_stock",
};
const product = {
  _id: productId, slug, is_published: true, region: null, sale_channels: { website: true },
  subcategory: { _id: categoryId }, thumbnail: "uploads/cx08.jpg",
};
const variant = {
  _id: variantId, product: productId, sale_price: 1450, regular_price: 1550, images: ["uploads/cx08-15w.webp"],
};
const campaign = {
  specialSaleActive: true, offer_start_date: "2026-11-10T00:00:00.000Z", validFor: 7, discountPercentage: 30,
  applied_subcategories: [{ _id: categoryId }],
};

function sourceFixture({
  detail = { product, variants: [variant] }, offer = campaign, stock = 0,
}: { detail?: unknown; offer?: unknown; stock?: unknown } = {}) {
  const requested: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.griipbuddy.com");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    requested.push(url.pathname);
    if (url.pathname === "/api/v1/cms/offer-page") return Response.json({ success: true, data: offer });
    if (url.pathname === `/api/v1/product/slug/${slug}`) {
      return detail ? Response.json({ success: true, data: detail }) : new Response(null, { status: 404 });
    }
    assert.equal(url.pathname, `/api/v1/stocks/${productId}/${variantId}`);
    return Response.json({ success: true, data: { totalAvailableQuantity: stock } });
  };
  return { request, requested };
}

test("uses the live Bangladesh promotion, sellable stock and landing link for the verified exact variant", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-16T12:00:00.000Z"));
  const { request, requested } = sourceFixture();
  const result = await refreshBangladeshMerchantItems([item], request);
  assert.deepEqual(result, { items: [{ ...item, amountMinor: 108500, stock: 0, availability: "out_of_stock",
    link: `https://griipbuddy.com/bd/product/${slug}`, imageLink: "https://d11ml80zmgyrxk.cloudfront.net/uploads/cx08-15w.webp",
  }], unavailableVariantIds: [] });
  assert.equal(requested.length, 3);
});

test("switches to the live sale price exactly when the timed offer ends", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-17T00:00:00.000Z"));
  const { request } = sourceFixture({ stock: 2 });
  const { items } = await refreshBangladeshMerchantItems([item], request);
  assert.equal(items[0]?.amountMinor, 145000);
  assert.equal(items[0]?.availability, "in_stock");
  assert.equal(items[0]?.stock, 2);
});

test("withholds multi-variant, unpublished, unmatched and missing listings without a stock request", async () => {
  for (const detail of [
    { product, variants: [variant, { ...variant, _id: "f".repeat(24) }] },
    { product: { ...product, sale_channels: { website: false } }, variants: [variant] },
    { product: { ...product, region: "INTERNATIONAL" }, variants: [variant] },
    { product, variants: [{ ...variant, _id: "f".repeat(24) }] },
    null,
  ]) {
    const { request, requested } = sourceFixture({ detail });
    assert.deepEqual(await refreshBangladeshMerchantItems([item], request), { items: [], unavailableVariantIds: [item.variantId] });
    assert.equal(requested.length, 2);
  }
  const foreign = { ...item, currency: "USD" as const };
  const { request, requested } = sourceFixture();
  assert.deepEqual(await refreshBangladeshMerchantItems([foreign], request), { items: [], unavailableVariantIds: [item.variantId] });
  assert.equal(requested.length, 0);
});

test("propagates upstream failures so the caller cannot publish guessed prices or stock", async () => {
  const { request } = sourceFixture({ stock: "unavailable" });
  await assert.rejects(refreshBangladeshMerchantItems([item], request));
  await assert.rejects(refreshBangladeshMerchantItems([item], async () => new Response(null, { status: 429 })), /429/);
});

const previewSettings = { marketId: "bd", origin: "https://dev.griipbuddy.com", regional: true } satisfies MerchantFeedSettings;
const previewImage = "/catalog/memo-cx08-15w-bd-merchant-v1.png";
function previewProduct(stock: number): CatalogProduct {
  return {
    id: item.productId, name: item.title, slug, brand: item.brand, description: item.description, departmentId: "coolers",
    specifications: [], keywords: [], addedOn: "2026-10-01", images: [{ src: "/media/cx08", alt: "Existing product photo" }],
    variants: [{ id: item.variantId, options: { power: "15 W" }, mpn: item.mpn, offer: {
      variantId: item.variantId, marketId: "bd", currency: "BDT", stock, amountMinor: 145000, regularMinor: 155000,
    } }],
  };
}

test("puts the same live offer and clean product image on the Bangladesh dev landing page and feed", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-16T12:00:00.000Z"));
  const { request } = sourceFixture();
  t.mock.method(globalThis, "fetch", request);

  const { items: [preview] } = await refreshDevBangladeshMerchantItems([{ ...item, stock: 0 }], request);
  const page = await merchantBdPreviewPageProduct(previewProduct(0), previewSettings);
  assert.equal(preview.link, item.link);
  assert.equal(preview.imageLink, new URL(previewImage, item.link).href);
  assert.equal(preview.amountMinor, 108500);
  assert.equal(preview.availability, "out_of_stock");
  assert.equal(page.variants[0].offer?.amountMinor, preview.amountMinor);
  assert.equal(page.variants[0].offer?.stock, 0);
  assert.deepEqual(page.images.map(photo => photo.src), [previewImage]);
  assert.equal(page.variants[0].image?.src, previewImage);
  const url = new URL(preview.link);
  assert.ok(merchantBdPreviewRobotsPaths().includes(url.pathname + url.search));

  const original = previewProduct(0);
  assert.equal(await merchantBdPreviewPageProduct(original, { ...previewSettings, marketId: "us" }), original);
});

test("withholds a preview whose stock or buyable price conflicts with checkout and hides stale purchase controls", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-11-16T12:00:00.000Z"));
  const { request } = sourceFixture();
  t.mock.method(globalThis, "fetch", request);
  const unavailable = { items: [], unavailableVariantIds: [item.variantId] };
  assert.deepEqual(await refreshDevBangladeshMerchantItems([{ ...item, stock: 2 }], request), unavailable);
  assert.deepEqual(await refreshDevBangladeshMerchantItems([{ ...item, stock: 2 }], sourceFixture({ stock: 2 }).request), unavailable);
  const page = await merchantBdPreviewPageProduct(previewProduct(2), previewSettings);
  assert.equal(page.variants[0].offer?.stock, 0);
});
