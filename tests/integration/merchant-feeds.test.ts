import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { collectMerchantFeed, merchantFeedXml } from "../../src/lib/catalog/merchant-feed.ts";
import { loadFixtureFeedSelection, parseFeedExport, serializeFixtureFeed } from "../../src/lib/catalog/merchant-feed-export.ts";
import { productMetadata } from "../../src/lib/catalog/product-metadata.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
process.env.GRIIP_HYBRID_STOREFRONT = "1";
const db = getDb();
after(() => db.$disconnect());

test("Google Shopping feeds match the exact landing variant and its market catalog", async t => {
  const suffix = randomUUID();
  const [productId, unknownBrand, unbranded, demo] = ["shirt", "compatible", "generic", "demo"].map(kind => `merchant-${kind}-${suffix}`);
  const productIds = [productId, unknownBrand, unbranded, demo];
  const [small, medium, invalid, compatible, generic, demoVariant] = ["small", "medium", "invalid", "compatible", "generic", "demo"]
    .map(kind => `v-feed-${kind}-${suffix}`);
  const variantIds = [small, medium, invalid, compatible, generic, demoVariant];
  const bdLocation = `feed-dhaka-${suffix}`;
  const usLocation = `feed-us-${suffix}`;
  const origin = "https://shop.example.invalid";
  const brand = "Case & Cloth";
  const gtin = "012345678905";
  const department = await db.department.findFirstOrThrow({ select: { id: true } });
  t.after(() => db.$transaction(async tx => {
    await tx.locationInventory.deleteMany({ where: { variantId: { in: variantIds } } });
    await tx.dispatchLocation.deleteMany({ where: { id: { in: [bdLocation, usLocation] } } });
    await tx.marketOffer.deleteMany({ where: { variantId: { in: variantIds } } });
    await tx.inventory.deleteMany({ where: { variantId: { in: variantIds } } });
    await tx.variant.deleteMany({ where: { id: { in: variantIds } } });
    await tx.product.deleteMany({ where: { id: { in: productIds } } });
  }));

  const product = (id: string, name: string) => ({
    id, slug: id, name, departmentId: department.id, description: "Cotton & size <guide>",
    specifications: [{ label: "Brand", value: "Device OEM" }], keywords: [], position: 20,
    addedOn: new Date(), publication: "ACTIVE" as const,
    images: { create: { position: 0, src: "/editorial/hero.webp", alt: "Synthetic feed fixture" } },
  });
  const now = Date.now();
  const variant = (id: string, size: string, sellInUs = true) => ({
    id, sku: id, label: `Deep Blue / ${size}`, options: { Color: "Deep Blue", Size: size }, position: 0,
    inventory: { create: { available: 7 } },
    offers: { create: [
      { marketId: "bd" as const, currency: "BDT" as const, amountMinor: 159900, discountMinor: 14900,
        discountStartsAt: new Date(now - 60_000), discountEndsAt: new Date(now + 600_000) },
      { marketId: "us" as const, currency: "USD" as const, amountMinor: 2999, eligible: sellInUs },
    ] },
  });
  await db.product.create({ data: { ...product(productId, "Cotton & Wool"), brand, variants: { create: [
    { ...variant(small, "S"), gtin }, { ...variant(medium, "M", false), mpn: "QA-PART-M" },
    { ...variant(invalid, "XL"), gtin: "012345678906" },
  ] } } });
  await db.product.create({ data: { ...product(unknownBrand, "Compatible phone case"), variants: { create: variant(compatible, "One size") } } });
  await db.product.create({ data: { ...product(unbranded, "Verified plain accessory"), variants: { create: {
    ...variant(generic, "One size"), identifiersNotAssigned: true,
  } } } });
  await db.product.create({ data: { ...product(demo, "Sample garment"), demo: true, brand, variants: { create: { ...variant(demoVariant, "S"), gtin } } } });
  await db.dispatchLocation.createMany({ data: [
    { id: bdLocation, name: "Dhaka test location", marketId: "bd" }, { id: usLocation, name: "US test location", marketId: "us" },
  ] });
  await db.locationInventory.createMany({ data: [
    { variantId: small, locationId: bdLocation, available: 2 }, { variantId: small, locationId: usLocation, available: 0 },
  ] });

  for (const marketId of ["bd", "us"] as const) {
    const settings = { marketId, origin, regional: true } as const;
    const catalogProducts = (await catalog.listProducts({ marketId })).filter(item => productIds.includes(item.id));
    const { items, issues } = collectMerchantFeed(catalogProducts, settings);
    assert.deepEqual(new Set(items.map(item => item.variantId)), new Set(marketId === "bd" ? [small, medium, generic] : [small, generic]));
    assert.ok(issues.some(issue => issue.variantId === compatible && issue.code === "missing_brand" && issue.severity === "excluded"));
    assert.ok(issues.some(issue => issue.variantId === invalid && issue.code === "invalid_gtin" && issue.severity === "excluded"));
    assert.ok(issues.some(issue => issue.variantId === demoVariant && issue.code === "demo"));
    assert.equal(items.find(item => item.variantId === generic)?.identifierExists, "no");
    assert.equal(items.find(item => item.variantId === generic)?.brand, undefined);
    if (marketId === "bd") {
      assert.ok(issues.some(issue => issue.variantId === medium && issue.code === "missing_gtin" && issue.severity === "review"));
      assert.equal(items.find(item => item.variantId === medium)?.mpn, "QA-PART-M");
    }
    const entry = items.find(item => item.variantId === small);
    assert.ok(entry);
    assert.deepEqual({ brand: entry.brand, gtin: entry.gtin, size: entry.size, color: entry.color }, { brand, gtin, size: "S", color: "Deep Blue" });
    const link = new URL(entry.link);
    assert.equal(link.origin, origin);
    assert.equal(link.pathname, `${marketId === "bd" ? "/bd" : ""}/products/${productId}`);
    assert.equal(link.searchParams.get("market"), marketId);
    assert.equal(link.searchParams.get("variant"), small);

    const publishedProduct = await catalog.getProduct(productId, marketId);
    assert.ok(publishedProduct);
    const markup = productMetadata(publishedProduct, entry.link).markup;
    assert.ok(markup);
    const pageVariants = "hasVariant" in markup ? markup.hasVariant : [markup];
    const exact = pageVariants?.find(item => item.sku === small);
    assert.ok(exact);
    assert.equal(exact.url, entry.link);
    assert.deepEqual({ brand: exact.brand?.name, gtin: exact.gtin, size: exact.size, color: exact.color }, { brand: entry.brand, gtin: entry.gtin, size: entry.size, color: entry.color });
    const expected = marketId === "bd" ? { price: "1450.00", currency: "BDT", availability: "InStock", stock: 2 }
      : { price: "29.99", currency: "USD", availability: "OutOfStock", stock: 0 };
    assert.equal(entry.stock, expected.stock);
    assert.equal(entry.amountMinor, Math.round(Number(expected.price) * 100));
    assert.equal(entry.availability, expected.stock ? "in_stock" : "out_of_stock");
    assert.deepEqual(exact.offers, {
      "@type": "Offer", url: entry.link, price: expected.price, priceCurrency: expected.currency,
      availability: `https://schema.org/${expected.availability}`,
    });

    const xml = merchantFeedXml(items, settings);
    assert.match(xml, /xmlns:g="http:\/\/base.google.com\/ns\/1.0"/);
    assert.ok(xml.includes(`<g:price>${expected.price} ${expected.currency}</g:price>`));
    assert.ok(xml.includes("<g:brand>Case &amp; Cloth</g:brand>"));
    assert.ok(xml.includes("Cotton &amp; size &lt;guide&gt;"));
    assert.ok(xml.includes("<g:identifier_exists>no</g:identifier_exists>"));
    assert.doesNotMatch(xml, /Device OEM|Sample garment|012345678906/);
  }

  const bdSelect = parseFeedExport(new URLSearchParams({ market: "bd", currency: "BDT", variant: medium,
    channel: "meta", condition: "new" }));
  const usSelect = parseFeedExport(new URLSearchParams({ market: "us", currency: "USD", variant: medium, channel: "google" }));
  assert.ok(bdSelect && usSelect);
  const before = await loadFixtureFeedSelection("bd", new Date(now - 60_001));
  const start = await loadFixtureFeedSelection("bd", new Date(now - 60_000));
  const end = await loadFixtureFeedSelection("bd", new Date(now + 600_000));
  const bdQuote = (feed: typeof start) => feed.items.find(item => item.variantId === medium)?.amountMinor;
  assert.deepEqual([bdQuote(before), bdQuote(start), bdQuote(end)], [159900, 145000, 159900]);
  const selectedMeta = serializeFixtureFeed(bdSelect, start);
  assert.ok(selectedMeta);
  assert.ok(selectedMeta.includes("<g:condition>new</g:condition>") && selectedMeta.includes("1450.00 BDT"));
  assert.ok(!selectedMeta.includes(small));
  assert.equal(serializeFixtureFeed(usSelect, await loadFixtureFeedSelection("us")), null);
  assert.equal(serializeFixtureFeed(usSelect, start), null);

  await db.marketOffer.update({ where: { variantId_marketId: { variantId: medium, marketId: "bd" } }, data: { publication: "DRAFT" } });
  assert.equal(serializeFixtureFeed(bdSelect, await loadFixtureFeedSelection("bd")), null);
  await db.variant.update({ where: { id: small }, data: { archivedAt: new Date(), active: false, optionSignature: "test-archive", sku: small.toUpperCase() } });
  assert.ok(!(await loadFixtureFeedSelection("bd")).items.some(item => item.variantId === small));

});
