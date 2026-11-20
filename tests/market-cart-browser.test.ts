import assert from "node:assert/strict";
import test from "node:test";
import { storefrontBasePath } from "../src/config/storefront-path.ts";
import { guestCart } from "../src/lib/cart/browser-guest.ts";
import { CART_STORAGE_KEY, cartMarketHeader, marketCartStorageKey, type CartItem } from "../src/lib/cart/model.ts";
import { applyLineChange, type LineChange } from "../src/lib/cart/line-mutations.ts";

test("guest carts verify old bindings and preserve new same-SKU quantities after checkout and sign-in", async t => {
  const bdLine = { variantId: "v-shared", offerId: "c8a25165-822f-4b64-808c-5a1e079abf0d", quantity: 2 };
  const usLine = { ...bdLine, offerId: "c8a25165-822f-4b64-808c-5a1e079abf1d" };
  const old = JSON.stringify([bdLine, usLine, { variantId: "v-unscoped", quantity: 1 }]);
  const legacyKey = CART_STORAGE_KEY + storefrontBasePath;
  const storage = new Map([[legacyKey, old]]);
  const browserStorage = { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: browserStorage } });
  t.after(() => Reflect.deleteProperty(globalThis, "window"));

  const lookups: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit) => {
    assert.equal(url, storefrontBasePath + "/api/cart/resolve");
    const { marketId, lines, action } = JSON.parse(String(init.body));
    lookups.push(marketId);
    assert.equal(action, "legacy-market-cart");
    assert.equal(new Headers(init.headers).get(cartMarketHeader), marketId);
    assert.equal(lines.length, 2);
    return Response.json({ marketId, matched: [marketId === "bd" ? bdLine : usLine] });
  });

  const bd = guestCart("bd");
  const us = guestCart("us");
  await Promise.all([bd.migrate(), us.migrate()]);
  assert.deepEqual(lookups.sort(), ["bd", "us"]);
  assert.equal(storage.get(legacyKey), old);
  assert.deepEqual(bd.getSnapshot().items, [bdLine]);
  assert.deepEqual(us.getSnapshot().items, [usLine]);
  assert.ok(storage.has(marketCartStorageKey("bd", storefrontBasePath)));
  assert.ok(storage.has(marketCartStorageKey("us", storefrontBasePath)));

  const mutate = (line: LineChange) => bd.mutate(snapshot => {
    const next = applyLineChange(snapshot, line, 99);
    return typeof next === "string" ? null : next;
  });
  const acquisition = bd.getSnapshot().revision;
  await mutate({ type: "add", ...bdLine, quantity: 1 });
  await bd.completePurchase("placed-test-order", [{ ...bdLine, cartOfferId: bdLine.offerId }], acquisition);
  assert.deepEqual(bd.getSnapshot().items, [{ ...bdLine, quantity: 1 }]);
  await bd.completePurchase("placed-test-order", [{ ...bdLine, cartOfferId: bdLine.offerId }], acquisition);
  assert.deepEqual(bd.getSnapshot().items, [{ ...bdLine, quantity: 1 }]);
  await bd.completePurchase("historical-attempt", [{ ...bdLine, cartOfferId: bdLine.offerId }]);
  assert.deepEqual(bd.getSnapshot().items, [{ ...bdLine, quantity: 1 }]);

  const handoff = await bd.claim("cart-fixture-shopper");
  assert.ok(handoff);
  assert.deepEqual(Object.keys(handoff).sort(), ["items", "operationId", "saved"]);
  assert.deepEqual(await bd.claim("cart-fixture-shopper"), handoff);
  assert.equal(await bd.claim("someone-else"), undefined);
  assert.equal(await mutate({ type: "remove", variantId: bdLine.variantId, offerId: bdLine.offerId, expectedQuantity: 1 }), true);
  await mutate({ type: "add", ...bdLine, quantity: 3 });
  await bd.finishMerge(handoff);
  assert.deepEqual(bd.getSnapshot().items, [{ ...bdLine, quantity: 3 } satisfies CartItem]);
  assert.deepEqual(us.getSnapshot().items, [usLine]);
});
