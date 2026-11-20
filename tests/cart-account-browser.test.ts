import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createAccountCart } from "../src/lib/cart/browser-account.ts";
import { cartSyncRequest, type CartSyncRequest } from "../src/lib/cart/sync-contract.ts";

test("account cart resumes the same mutation after reload and processes queued placed-order cleanup", async (t) => {
  const storage = new Map<string, string>();
  const browserStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  };
  const events = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    ...events, sessionStorage: browserStorage, localStorage: browserStorage, setInterval() {}, clearInterval() {},
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: events });
  let unmount = () => {};
  t.after(() => {
    unmount();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  });

  const shopperId = "account-fixture";
  const marketId = "bd";
  const orderId = "6e27fc6a-7ee7-4b55-9111-ad56f708a77a";
  const bought = { variantId: "v-fitted-case", offerId: "c8a25165-822f-4b64-808c-5a1e079abf0d", personalization: "Case A", quantity: 2 };
  const retained = { ...bought, personalization: "Case B", quantity: 1 };
  const requests: CartSyncRequest[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit) => {
    const request = cartSyncRequest.parse(JSON.parse(String(init.body)));
    requests.push(request);
    if (requests.length === 1) return Response.json({ shopperId, marketId, revision: 0, items: [bought, retained], saved: [] });
    if (requests.length === 2) throw new TypeError("Response unavailable after the mutation was dispatched");
    if (requests.length === 3) return Response.json({ shopperId, marketId, revision: 1, items: [{ ...bought, quantity: 3 }, retained], saved: [] });
    return Response.json({ shopperId, marketId, revision: 2, items: [retained], saved: [] });
  });

  const create = () => createAccountCart(shopperId, marketId, async () => undefined, async () => {});
  const account = create();
  unmount = account.mount();
  await setImmediate();
  const command = { ...bought, type: "set" as const, quantity: 3, expectedQuantity: bought.quantity };
  const changing = account.change(command);
  assert.equal(await account.change(command), false);
  assert.equal(await changing, false);
  await account.completePurchase(orderId);
  assert.equal(requests.length, 2);
  unmount();

  const reloaded = create();
  unmount = reloaded.mount();
  await setImmediate();
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[2], requests[1]);
  assert.deepEqual(requests[3], { shopperId, marketId, action: "cart-sync", mode: "change", operationId: orderId,
    command: { type: "complete-purchase", orderId } });
  assert.deepEqual(reloaded.getSnapshot().items, [retained]);
  assert.equal(storage.size, 1);
  assert.equal([...storage.values()][0], orderId);
});
