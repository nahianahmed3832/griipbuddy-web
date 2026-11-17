import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { readDevAdminOrderProof } from "../src/lib/staff/dev-admin-order-proof.ts";

test("the short-lived fulfillment proof authenticates the exact order, operator and command", () => {
  const secret = "11".repeat(32);
  process.env.GRIIP_HYBRID_ADMIN_FULFILLMENT_TOKEN = secret;
  const now = 1794945600_000;
  const payload = { id: "b4a587ae-9628-4558-8b58-632286745313", operator: {
    id: "660af8c76323be80936e0ebf", name: "Fixture operator", canReturn: false,
  }, command: { action: "advance", next: "SHIPPED", simulate: true } };
  const body = JSON.stringify(payload);
  const sign = (raw: string, stamp: number) => `${stamp}.` + createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`griipbuddy/hybrid-fulfillment/v1\n${stamp}\n${raw}`).digest("hex");
  const timestamp = Math.floor(now / 1000);
  const header = sign(body, timestamp);
  assert.deepEqual(readDevAdminOrderProof(body, header, now), payload);
  for (const altered of [body.replace(payload.id, "b4a587ae-9628-4558-8b58-632286745314"),
    body.replace("SHIPPED", "PACKING"), body.replace('"canReturn":false', '"canReturn":true')]) {
    assert.equal(readDevAdminOrderProof(altered, header, now), null);
  }
  assert.equal(readDevAdminOrderProof(body, sign(body, timestamp - 31), now), null);
  assert.equal(readDevAdminOrderProof(body, sign(body, timestamp + 6), now), null);
  const unconfirmed = JSON.stringify({ ...payload, command: { action: "cancel", confirm: false } });
  assert.equal(readDevAdminOrderProof(unconfirmed, sign(unconfirmed, timestamp), now), null);
});
