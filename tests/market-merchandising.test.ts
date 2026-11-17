import assert from "node:assert/strict";
import test from "node:test";
import { departmentTree, stockedDepartments } from "../src/lib/catalog/departments.ts";
import { discountPercentage, listingView, toCard } from "../src/lib/catalog/listing.ts";
import type { CatalogProduct, Department, MarketOffer } from "../src/lib/catalog/types.ts";

const image = { src: "/editorial/hero.webp", alt: "Example item" };

function category(id: string, parentId?: string): Department {
  return { id, slug: id, shortName: id, name: id, description: "", image, parentId };
}

function offer(variantId: string, amountMinor: number, stock: number, regularMinor?: number): MarketOffer {
  return { variantId, marketId: "bd", currency: "BDT", amountMinor, stock, regularMinor };
}

const products: CatalogProduct[] = [{
  id: "case", departmentId: "cases", slug: "case", name: "Case", description: "",
  specifications: [], keywords: [], images: [image], addedOn: "2026-11-16",
  variants: [
    { id: "blue", options: { Color: "Blue" }, offer: offer("blue", 1800, 2, 2000) },
    { id: "pink", options: { Color: "Pink" }, offer: offer("pink", 1500, 1, 2000) },
    { id: "gray", options: { Color: "Gray" }, offer: offer("gray", 1100, 0, 2000) },
  ],
}];

test("a market with one sellable leaf keeps its ancestors and finds it through the root", () => {
  const departments = [category("tech"), category("phone-accessories", "tech"), category("cases", "phone-accessories"), category("fashion")];
  const visible = stockedDepartments(departments, ["cases"]);
  assert.deepEqual(visible.map(department => department.id), ["tech", "phone-accessories", "cases"]);
  assert.equal(departmentTree(visible)[0]?.children[0]?.children[0]?.id, "cases");
  assert.equal(listingView(products, departments, { department: "tech" }).cards[0]?.id, "case");
});

test("the promotion links to the in-stock SKU with the price shown in the card", () => {
  const card = toCard(products[0]);
  assert.ok(card);
  assert.equal(card.variantId, "pink");
  assert.equal(card.priceMinor, 1500);
  assert.equal(discountPercentage(card), 25);
  assert.equal(card.stock, 3);
});

const pro = "iphone-16-pro";
const proMax = "iphone-16-pro-max";
const multiFit: CatalogProduct = {
  ...products[0], keywords: ["iPhone 16 Pro", "iPhone 16 Pro Max"],
  variants: [
    { id: "blue-max", options: { Color: "Blue", "Phone Model": "iPhone 16 Pro Max" }, offer: offer("blue-max", 900, 8, 1300) },
    { id: "black-pro", options: { Color: "Black", "Phone Model": "iPhone 16 Pro" }, offer: offer("black-pro", 1400, 2) },
    { id: "red-pro", options: { Color: "Red", "Phone Model": "iPhone 16 Pro" }, offer: offer("red-pro", 1800, 3, 2200) },
    { id: "white-pro", options: { Color: "White", "Phone Model": "iPhone 16 Pro" }, offer: offer("white-pro", 1600, 0, 2300) },
    { id: "unknown", options: { Color: "Gray" }, offer: offer("unknown", 800, 12, 1300) },
  ],
};

function browse(product: CatalogProduct, params: Parameters<typeof listingView>[2], inferredDeviceId?: string) {
  return listingView([product], [], params, false, "recommended", 2, true, inferredDeviceId);
}

test("phone-model listing cards and facets use compatible variants even when another model is cheaper", () => {
  const listing = browse(multiFit, { device: pro });
  assert.deepEqual(listing.colors, ["Black", "Red", "White"]);
  assert.deepEqual(listing.cards.map(({ variantId, priceMinor, stock, inStock }) =>
    ({ variantId, priceMinor, stock, inStock })), [
    { variantId: "black-pro", priceMinor: 1400, stock: 5, inStock: true },
  ]);
  assert.equal(toCard(multiFit, "", proMax)?.variantId, "blue-max");
  assert.deepEqual(browse(multiFit, { device: pro, color: "Blue" }).cards, []);
});

test("price, stock and sale filters are evaluated against the same compatible variant", () => {
  const listing = browse(multiFit, { device: pro, availability: "in-stock", min: "15", max: "19", offer: "sale" });
  const { variantId, priceMinor, regularMinor, stock } = listing.cards[0]!;
  assert.deepEqual({ variantId, priceMinor, regularMinor, stock },
    { variantId: "red-pro", priceMinor: 1800, regularMinor: 2200, stock: 3 });
  assert.deepEqual(browse(multiFit, { device: pro, availability: "in-stock", color: "White" }).cards, []);
  const unavailable = browse(multiFit, { device: pro, color: "White" }).cards[0];
  assert.equal(unavailable?.variantId, "white-pro");
  assert.equal(unavailable?.inStock, false);
});

test("model searches do not add filter chips or override an explicit incompatible fit", () => {
  const inferred = browse(multiFit, {}, pro);
  assert.equal(inferred.device, "");
  assert.equal(inferred.cards[0]?.variantId, "black-pro");
  const conflict = browse(multiFit, { device: proMax }, pro);
  assert.equal(conflict.device, proMax);
  assert.deepEqual(conflict.cards, []);
});

test("legacy product fit still works while a known model with no eligible offer stays an active filter", () => {
  const legacy = { ...products[0], keywords: ["iPhone 16 Pro"] };
  assert.equal(browse(legacy, { device: pro }).cards[0]?.variantId, "pink");
  const noProOffer = {
    ...multiFit,
    variants: multiFit.variants.map(variant => variant.options["Phone Model"] === "iPhone 16 Pro" ? { ...variant, offer: null } : variant),
  };
  const selected = browse(noProOffer, { device: pro });
  assert.equal(selected.device, pro);
  assert.equal(selected.active, true);
  assert.deepEqual(selected.cards, []);
});
