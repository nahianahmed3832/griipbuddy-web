import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  bindCommerceScope, CommerceContractError, commerceReferenceFor, validateCommerceMoney,
} from "../src/lib/commerce/service-contract.ts";
import { bridgeSignatureDomain, readSignedBridge, type BridgeBinding } from "../src/lib/measurement/bridge-contract.ts";

const bd = bindCommerceScope({ authority: "express-fixture", marketId: "bd", currency: "BDT" });
const us = bindCommerceScope({ authority: "native-fixture", marketId: "us", currency: "USD" });
const errorCode = (code: CommerceContractError["code"]) =>
  (error: unknown) => error instanceof CommerceContractError && error.code === code;

test("qualified record identities preserve source and market even when local IDs collide", () => {
  const sourceId = "ABC123";
  const order = commerceReferenceFor(bd, "order", sourceId);
  assert.deepEqual(order, { authority: bd.authority, marketId: bd.marketId, kind: "order", sourceId });
  assert.notDeepEqual(order, commerceReferenceFor(us, "order", sourceId));
  assert.notDeepEqual(order, commerceReferenceFor(bd, "payment", sourceId));
  assert.throws(() => commerceReferenceFor(bd, "order", "../ABC123"), errorCode("invalid_input"));
});

test("market and minor amounts reject unsupported, inconsistent and lossy inputs", () => {
  assert.throws(() => bindCommerceScope({ ...bd, marketId: "unknown" }), errorCode("invalid_input"));
  assert.throws(() => bindCommerceScope({ ...bd, currency: "USD" }), errorCode("market_mismatch"));
  assert.throws(() => validateCommerceMoney(us, { amountMinor: 12.5, currency: "USD" }), errorCode("invalid_input"));
  assert.throws(() => validateCommerceMoney(us, { amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "USD" }),
    errorCode("invalid_input"));
  assert.throws(() => validateCommerceMoney(us, { amountMinor: 2500, currency: "BDT" }), errorCode("market_mismatch"));
  assert.deepEqual(validateCommerceMoney(bd, { amountMinor: 2500, currency: "BDT" }),
    { amountMinor: 2500, currency: "BDT" });
});

test("signed report ingress retains its authorized scope and rejects wrong-currency orders", () => {
  const binding: BridgeBinding = { ...bd, secret: "fixture-outcome-key-for-isolated-verification", scope: "isolated-fixture" };
  const bookedAt = "2026-11-20T00:00:00.000Z";
  const order = {
    sourceOrderId: "legacy-order-1", currency: "BDT", paymentMethod: "COD", bookedAt, totalMinor: 1500,
    events: [{ sourceEventId: "legacy-event-1", kind: "ORDER_ACCEPTED", at: bookedAt, amountMinor: 1500 }],
  };
  const signed = (authority: string, currency: string, key = binding.secret) => {
    const body = JSON.stringify({ version: 1, authority, marketId: bd.marketId, evidence: "fixture", orders: [{ ...order, currency }] });
    const signature = createHmac("sha256", key).update(bridgeSignatureDomain).update(body).digest("hex");
    return Buffer.from(signature + "\n" + body);
  };
  const now = new Date(bookedAt);
  assert.equal(readSignedBridge(signed(bd.authority, "BDT"), binding, now).orders[0].sourceOrderId, order.sourceOrderId);
  assert.throws(() => readSignedBridge(signed(bd.authority, "USD"), binding, now), errorCode("market_mismatch"));
  assert.throws(() => readSignedBridge(signed(us.authority, "BDT"), binding, now), errorCode("market_mismatch"));
  assert.throws(() => readSignedBridge(signed(bd.authority, "BDT", "wrong-fixture-key"), binding, now), errorCode("forbidden"));
});
