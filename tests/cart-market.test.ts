import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, getMarket, markets } from "../src/config/markets.ts";
import { marketPreferenceTarget } from "../src/config/regional-path.ts";
import { demoCatalogRepository as catalog } from "./fixture-catalog.ts";
import { addToItems, decodeCart, evaluateCart, updateItems, type CartItem } from "../src/lib/cart/model.ts";
import { previewDirectCheckout } from "../src/lib/commerce/checkout-market.ts";

test("market offers use explicit prices and only list products sold in that market", async () => {
  const [bd, us, departments] = await Promise.all([
    catalog.listProducts({ marketId: "bd" }), catalog.listProducts({ marketId: "us" }), catalog.listDepartments(),
  ]);
  assert.equal(bd.length, 24);
  assert.equal(us.length, 23);
  assert.equal(departments.length, 6);
  assert.ok(departments.every(({ id }) => bd.filter((product) => product.departmentId === id).length === 4));
  assert.ok(bd.some(({ slug }) => slug === "dome-table-lamp"));
  assert.ok(!us.some(({ slug }) => slug === "dome-table-lamp"));
  assert.ok(bd.flatMap(({ variants }) => variants).every(({ offer }) => !offer || offer.currency === "BDT" && Number.isInteger(offer.amountMinor)));
  assert.ok(us.flatMap(({ variants }) => variants).every(({ offer }) => !offer || offer.currency === "USD" && Number.isInteger(offer.amountMinor)));
  assert.equal(getMarket("__proto__").id, "bd");
});

test("cart keeps lines when a market changes and excludes ineligible quantities from the subtotal", async () => {
  const items: CartItem[] = [
    { variantId: "v-tote-plum", quantity: 2 },
    { variantId: "v-tote-oat", quantity: 3 },
    { variantId: "v-bottle-plum", quantity: 1 },
    { variantId: "v-carry-set", quantity: 2 },
    { variantId: "v-removed-sku", quantity: 1 },
  ];
  const ids = items.map(({ variantId }) => variantId);
  const bd = evaluateCart(items, await catalog.resolveVariants(ids, "bd"), markets.bd);
  const us = evaluateCart(items, await catalog.resolveVariants(ids, "us"), markets.us);
  assert.deepEqual(bd.lines.map(({ status }) => status), ["available", "available", "available", "available", "removed"]);
  assert.equal(bd.subtotalMinor, 1220000);
  assert.deepEqual(us.lines.map(({ status }) => status), ["available", "not-sold", "out-of-stock", "over-stock", "removed"]);
  assert.equal(us.subtotalMinor, 3600);
  assert.equal(us.eligibleQuantity, 2);
  assert.deepEqual(us.lines.map(({ quantity }) => quantity), [2, 3, 1, 2, 1]);
  assert.equal(formatMoney(us.subtotalMinor, markets.us), "$36.00");

  const adjusted = updateItems(items, "v-carry-set", 1, 1);
  assert.equal(evaluateCart(adjusted, await catalog.resolveVariants(ids, "us"), markets.us).subtotalMinor, 7450);
});

test("changing the storefront market keeps the selected item and clears old routing hints", () => {
  const product = new URL("https://dev.griipbuddy.com/products/canvas-carryall-tote?variant=v-tote-plum&market=us&ref=search#details");
  const switched = marketPreferenceTarget(product, "bd");
  assert.equal(switched.href, "https://dev.griipbuddy.com/bd/products/canvas-carryall-tote?variant=v-tote-plum&ref=search#details");
  assert.equal(product.searchParams.get("market"), "us");
  assert.equal(marketPreferenceTarget(switched, "us").searchParams.get("market"), "us");

  const checkout = new URL("https://dev.griipbuddy.com/bd/checkout?destination=bd&buy=v-tote-plum&quantity=2&market=bd");
  assert.equal(marketPreferenceTarget(checkout, "us").href,
    "https://dev.griipbuddy.com/checkout?destination=us&buy=v-tote-plum&quantity=2");
});

test("cart rejects additions beyond stock and validates saved identities and quantities", () => {
  const saved = decodeCart(JSON.stringify([
    { variantId: "v-tote-plum", quantity: 1, amountMinor: 1 },
    { variantId: "v-tote-plum", quantity: 2 },
    { variantId: "v-tote-oat", quantity: -5 },
    { variantId: "oops", quantity: 3 },
  ]));
  assert.deepEqual(saved, [{ variantId: "v-tote-plum", quantity: 3 }]);
  assert.deepEqual(decodeCart("{ invalid"), []);
  assert.equal(addToItems(saved, "v-tote-plum", 2, 4), null);
  assert.equal(addToItems(saved, "v-tote-oat", 1, 0), null);
  assert.deepEqual(addToItems(saved, "v-tote-plum", 1, 4), [{ variantId: "v-tote-plum", quantity: 4 }]);
  assert.equal(updateItems(saved, "v-tote-plum", 5, 4), saved);
});

test("Buy it now can explain a missing destination offer without using the other market's price", async () => {
  const id = "v-tote-oat";
  const [[bd], [us]] = await Promise.all([catalog.resolveVariants([id], "bd"), catalog.resolveVariants([id], "us")]);
  assert.ok(bd?.offer);
  const unavailable = previewDirectCheckout(id, 1, us, bd);
  assert.equal(unavailable.reason, "not-sold");
  assert.equal(unavailable.name, bd.name);
  assert.equal(unavailable.slug, bd.slug);
  assert.equal(unavailable.unitMinor, null);
  assert.equal(unavailable.stock, null);
  assert.equal(previewDirectCheckout(id, bd.offer.stock + 1, bd, us).reason, "over-stock");
});
