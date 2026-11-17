import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogDeviceById, catalogDevices, phoneModels } from "../src/lib/catalog/devices.ts";
import { listingView, toSearchCard } from "../src/lib/catalog/listing.ts";
import { searchDevice, searchProducts } from "../src/lib/catalog/search.ts";
import type { CatalogProduct } from "../src/lib/catalog/types.ts";

const offer = { variantId: "v-black", marketId: "bd", currency: "BDT", amountMinor: 20_000, stock: 3 } as const;
const department = { name: "Phone Cases", shortName: "Cases" };

function product(id: string, name: string, extras: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id, slug: id, name, departmentId: "phone-cases", description: "A protective accessory.",
    keywords: [], specifications: [], images: [], addedOn: "2026-11-17",
    variants: [{ id: offer.variantId, options: { Color: "Black" }, offer }],
    ...extras,
  };
}

function results(query: string, ...products: CatalogProduct[]) {
  return searchProducts(products, new Map([["phone-cases", department]]), query).map(item => item.id);
}

test("compact Apple model queries preserve exact generation and Pro/Pro Max fit", () => {
  const titlePro = product("pro", "iPhone 16 Pro MagSafe Case");
  const aliasPro = product("tag-pro", "Clear MagSafe Case", { keywords: ["iPhone16-Pro"] });
  const proMax = product("max", "iPhone 16Pro Max MagSafe Case", {
    keywords: ["iPhone 16 Pro Max", "iPhone 16pro MagSafe Case"],
    description: "This case does not fit iPhone 16 Pro.",
  });
  const compactTitlePro = product("compact-pro", "iphone16pro MagSafe Case");
  const base = product("base", "iPhone 16 MagSafe Case");
  const otherGeneration = product("other", "iPhone 15 Pro MagSafe Case");
  const products = [aliasPro, proMax, base, otherGeneration, titlePro, compactTitlePro];
  const expected = ["pro", "compact-pro", "tag-pro"];
  assert.deepEqual(results("iphone16pro", ...products), expected);
  assert.deepEqual(results("cases for Apple iPhone-16 Pro", ...products), expected);
  assert.deepEqual(results("iphone16proMAX case", ...products), ["max"]);
  assert.deepEqual(results("Apple iPhone 16 pm", ...products), ["max"]);
  assert.deepEqual(results("iPhone 16 Pro wallet", ...products), []);
  assert.equal(searchDevice("MagSafe case for iphone16promax")?.id, "iphone-16-pro-max");
  assert.equal(searchDevice("iPhone 16 Pro or iPhone 16 Pro Max"), undefined);
});

test("common Android aliases retain exact model numbers and suffixes", () => {
  const z11Base = product("z11", "iQOO Z11 phone case");
  const z11Turbo = product("z11-turbo", "iQOO Z11 Turbo protective cover");
  const unrelated = product("z110", "Z110 Turbo protective cover");
  const older = product("z10", "iQOO Z10 Turbo protective cover");
  const products = [z11Turbo, unrelated, older, z11Base];
  assert.deepEqual(results("z-11", ...products), ["z11", "z11-turbo"]);
  assert.deepEqual(results("iqooZ11-Turbo", ...products), ["z11-turbo"]);
  assert.deepEqual(results("z110", ...products), ["z110"]);
  assert.equal(searchDevice("z11")?.id, "iqoo-z11");
  assert.equal(searchDevice("z11turbo")?.id, "iqoo-z11-turbo");

  const s24Base = product("s24", "Samsung Galaxy S24 phone case");
  const s24Plus = product("s24-plus", "Samsung Galaxy S24 Plus protective cover");
  const s24Ultra = product("s24-ultra", "Samsung Galaxy S24 Ultra protective cover");
  assert.deepEqual(results("galaxy S24+", s24Base, s24Plus, s24Ultra), ["s24-plus"]);
  assert.deepEqual(results("S24U", s24Base, s24Plus, s24Ultra), ["s24-ultra"]);

  const pixel8 = product("pixel8", "Google Pixel 8 cover");
  const pixel8a = product("pixel8a", "Pixel8a cover");
  assert.deepEqual(results("pixel 8a", pixel8, pixel8a), ["pixel8a"]);
  assert.equal(phoneModels("Nothing Phone (3a)")[0]?.id, "nothing-phone-3a");
  assert.equal(searchDevice("case for nothing3a")?.id, "nothing-phone-3a");
  assert.equal(searchDevice("redmi turbo4pro")?.id, "redmi-turbo-4-pro");
  assert.equal(catalogDeviceById("iphone-14-pro-max")?.name, "iPhone 14 Pro Max");
});

test("a market with no compatible offer cannot match copied fit text", () => {
  const split = product("split", "Phone Case for iPhone 16 Pro Max", {
    keywords: ["iPhone 16 Pro Max", "Transparent"],
    variants: [
      { id: "v-units-pro-max", options: { "Compatible model": "iPhone16 Pro Max" }, offer: null },
      { id: "v-units-pro", options: { "Compatible model": "iPhone16 Pro", Color: "iPhone 16 Pro Max edition" }, offer },
      { id: "v-unidentified", options: { Color: "Transparent" }, offer },
    ],
  });
  assert.deepEqual(results("iphone16pro max", split), []);
  assert.deepEqual(results("iphone 16 pro", split), ["split"]);
  assert.deepEqual(catalogDevices([split]).map(model => model.id), ["iphone-16-pro"]);
});

test("ordinary text and accent folding still work alongside phone parsing", () => {
  const headphones = product("headphones", "Studio Wireless Headphones", { description: "Play music over Bluetooth." });
  const caseCover = product("case", "Leather Case", { description: "Café brown and টেকসই।" });
  assert.deepEqual(results("wireless", caseCover, headphones), ["headphones"]);
  assert.deepEqual(results("wireless bluetooth", caseCover, headphones), ["headphones"]);
  assert.deepEqual(results("cafe", caseCover, headphones), ["case"]);
  assert.deepEqual(results("টেকসই", caseCover, headphones), ["case"]);
});

test("newly detected phone models follow the existing homepage's featured order", () => {
  const products = [
    product("pixel", "Google Pixel 8a case"),
    product("max", "iPhone 16 Pro Max case"),
    product("neo", "iQOO Neo 11 case"),
    product("ultra", "Galaxy S25 Ultra case"),
  ];
  assert.deepEqual(catalogDevices(products).map(model => model.id),
    ["iphone-16-pro-max", "samsung-galaxy-s25-ultra", "iqoo-neo-11", "google-pixel-8a"]);
});

test("family search links to a matching SKU and keeps explicit device filters exact", () => {
  const modelCase = product("mixed-z", "Clear Case for iQOO Z series", {
    images: [{ src: "/case.webp", alt: "Clear case" }],
    variants: [
      { id: "v-z10", options: { Model: "Z10 Turbo" }, offer: { ...offer, amountMinor: 10_000 } },
      { id: "v-z11-turbo", options: { Model: "Z11 Turbo" }, offer: { ...offer, amountMinor: 20_000 } },
      { id: "v-z110", options: { Model: "Z110" }, offer: { ...offer, amountMinor: 12_000 } },
    ],
  });
  const inferred = searchDevice("z-11");
  assert.ok(inferred);
  assert.equal(toSearchCard(modelCase, inferred)?.variantId, "v-z11-turbo");
  const listing = (fixture: CatalogProduct, params = {}) =>
    listingView([fixture], [], params, false, "recommended", 2, true, inferred.id);
  assert.equal(listing(modelCase).cards[0]?.variantId, "v-z11-turbo");
  assert.deepEqual(listing(modelCase).devices.map(model => model.id), ["iqoo-z11-turbo"]);
  assert.equal(listing(modelCase, { device: "iqoo-z11" }).cards.length, 0);
  assert.equal(listing(modelCase, { device: "iqoo-z10-turbo" }).cards.length, 0);

  const base = { id: "v-z11", options: { Model: "iQOO Z11" }, offer: { ...offer, amountMinor: 25_000 } };
  const withBase = { ...modelCase, variants: [...modelCase.variants, base] };
  const preferred = listing(withBase).cards[0];
  assert.equal(preferred.variantId, "v-z11");
  assert.equal(preferred.priceMinor, 25_000);
  assert.equal(preferred.multiplePrices, false);
  assert.equal(toSearchCard(withBase, inferred)?.variantId, "v-z11");
  assert.equal(listing(withBase, { device: "iqoo-z11-turbo" }).cards[0]?.variantId, "v-z11-turbo");
  const soldOutBase = { ...withBase, variants: [...modelCase.variants, { ...base, offer: { ...base.offer, stock: 0 } }] };
  assert.equal(listing(soldOutBase).cards[0]?.variantId, "v-z11-turbo");
  assert.equal(listing(soldOutBase, { device: "iqoo-z11" }).cards[0]?.variantId, "v-z11");
});
