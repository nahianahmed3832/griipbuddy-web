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
