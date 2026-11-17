import assert from "node:assert/strict";
import { test } from "node:test";
import { marketStoreHref } from "../src/config/regional-path.ts";
import { storefrontPath } from "../src/config/storefront-path.ts";
import { orderRecoveryCredential, orderRecoveryExpiry, orderRecoveryPaths } from "../src/lib/commerce/order-recovery.ts";

test("private tracking credentials expire and stay bound to their order, checkout and purpose", () => {
  const previousSecret = process.env.CHECKOUT_SECRET;
  process.env.CHECKOUT_SECRET = "order-recovery-test-signing-secret-only";
  try {
    const now = 1_900_000_000;
    const expires = now + 90;
    const proof = { id: "0e9627b5-5426-479b-b635-da54661152ea", guestKey: "a".repeat(64) };
    const other = { ...proof, id: "13a5bd5f-13ad-489e-a98c-ac93ffd0ad79" };
    const link = orderRecoveryCredential("link", proof, expires);
    const receipt = orderRecoveryCredential("receipt", proof, expires);

    assert.equal(orderRecoveryExpiry("link", proof, link, now), expires);
    assert.equal(orderRecoveryExpiry("receipt", proof, receipt, now), expires);
    assert.equal(orderRecoveryExpiry("receipt", proof, link, now), null);
    assert.equal(orderRecoveryExpiry("link", proof, receipt, now), null);
    assert.equal(orderRecoveryExpiry("link", other, link, now), null);
    assert.equal(orderRecoveryExpiry("link", { ...proof, guestKey: "b".repeat(64) }, link, now), null);
    assert.equal(orderRecoveryExpiry("link", proof, link, expires), null);
    assert.equal(orderRecoveryExpiry("link", proof, link.replace(`.${expires}.`, `.${expires + 1}.`), now), null);
  } finally {
    if (previousSecret === undefined) delete process.env.CHECKOUT_SECRET;
    else process.env.CHECKOUT_SECRET = previousSecret;
  }
});

test("recovered receipt URLs and cookies follow the selected market without sharing order paths", () => {
  const id = "0e9627b5-5426-479b-b635-da54661152ea";
  assert.deepEqual(orderRecoveryPaths(id, "bd", true), {
    claim: storefrontPath(`/bd/orders/recover/${id}`),
    receipt: storefrontPath(`/bd/orders/${id}`),
    cookiePath: storefrontPath(`/bd/orders/${id}`),
  });
  assert.deepEqual(orderRecoveryPaths(id, "us", true), {
    claim: storefrontPath(`/orders/recover/${id}?market=us`),
    receipt: storefrontPath(`/orders/${id}?market=us`),
    cookiePath: storefrontPath(`/orders/${id}`),
  });
});

test("storefront country links replace an old market pin and keep other query and fragment values", () => {
  assert.equal(marketStoreHref("/shop?sort=newest&market=us#products", "bd"), "/bd/shop?sort=newest#products");
  assert.equal(marketStoreHref("/bd/checkout?buy=v-tote-plum&destination=us#delivery", "us"),
    "/checkout?buy=v-tote-plum&destination=us&market=us#delivery");
  assert.equal(marketStoreHref("/api/checkout?market=bd", "us"), "/api/checkout?market=bd");
  assert.equal(marketStoreHref("/bd/admin?market=bd", "us"), "/bd/admin?market=bd");
});
