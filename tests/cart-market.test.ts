import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, getMarket, markets } from "../src/config/markets.ts";
import { demoCatalogRepository as catalog } from "./fixture-catalog.ts";
import { addToItems, cartItemKey, decodeCart, evaluateCart, purchasedCartItem, updateItems, type CartItem } from "../src/lib/cart/model.ts";

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

test("cart merges only matching variant, offer and personalization while repricing to a current offer", () => {
  const variantId = "v-phone-a-wave-blue";
  const other = "v-phone-b-wave-black";
  const bdOffer = "c8a25165-822f-4b64-808c-5a1e079abf0d";
  const usOffer = "dde2a5da-1b16-4974-aa83-5d87c3820c8f";
  const lines = decodeCart(JSON.stringify([
    { variantId, offerId: bdOffer, quantity: 1, personalization: "A" },
    { variantId, offerId: bdOffer, quantity: 2, personalization: "A" },
    { variantId, offerId: usOffer, quantity: 1 },
    { variantId: other, offerId: usOffer, quantity: 1 },
    { variantId, offerId: "invalid", quantity: 1 },
  ]));
  assert.deepEqual(lines.map(line => line.quantity), [3, 1, 1]);
  assert.equal(new Set(lines.map(cartItemKey)).size, 3);
  assert.equal(addToItems(lines, variantId, 1, 4, "A", bdOffer), null);
  assert.equal(updateItems(lines, variantId, 2, 4, "A", bdOffer)[0].quantity, 2);

  const caseInUS = { variantId, requestedOfferId: bdOffer, slug: "phone-case", name: "Phone case",
    variantLabel: "Phone A / Wave / Blue", image: { src: "/catalog/phone-stand.webp", alt: "Fixture" },
    personalization: { prompt: "Inscription", required: false }, offer: {
      id: usOffer, variantId, marketId: "us" as const, currency: "USD" as const, amountMinor: 2400, stock: 5,
    } };
  const rebased = evaluateCart(lines, [caseInUS], markets.us);
  assert.equal(rebased.subtotalMinor, 7200);
  assert.deepEqual(rebased.lines.map(line => line.status), ["available", "removed", "removed"]);
  assert.deepEqual(rebased.checkoutItems, [{ variantId, offerId: usOffer, cartOfferId: bdOffer, quantity: 3, personalization: "A" }]);
  assert.deepEqual(purchasedCartItem(rebased.checkoutItems[0]), lines[0]);

  const duplicate = evaluateCart([{ variantId, offerId: bdOffer, quantity: 1 }, { variantId, offerId: usOffer, quantity: 1 }],
    [caseInUS, { ...caseInUS, requestedOfferId: usOffer }], markets.us);
  assert.deepEqual(duplicate.lines.map(line => line.status), ["duplicate-offer", "duplicate-offer"]);
  assert.deepEqual(duplicate.checkoutItems, []);
  const alias = { variantId: "v-migrated-alias", quantity: 1 };
  const mapped = evaluateCart([alias], [{ ...caseInUS, requestedVariantId: alias.variantId, requestedOfferId: undefined }], markets.us);
  assert.equal(mapped.checkoutItems[0].cartVariantId, alias.variantId);
  assert.deepEqual(purchasedCartItem(mapped.checkoutItems[0]), alias);
});
