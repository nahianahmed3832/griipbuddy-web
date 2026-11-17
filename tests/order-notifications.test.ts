import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCheckoutEmail } from "../src/lib/commerce/checkout-types.ts";
import { orderNoticeContent } from "../src/lib/commerce/order-notifications.ts";

const reference = "GB-ABCDEF012345";

test("demo checkout keeps an explicit synthetic inbox, masks real addresses, and preserves an omitted recipient", () => {
  assert.equal(demoCheckoutEmail("Guest-Preview@Example.Invalid"), "guest-preview@example.invalid");
  assert.equal(demoCheckoutEmail("buyer@example.com"), "checkout@example.invalid");
  assert.equal(demoCheckoutEmail(null), undefined);
});

test("order receipt describes manual payment review and keeps the tracking credential in the private body", () => {
  const privateUrl = "https://dev.griipbuddy.com/bd/orders/recover/receipt#access=synthetic";
  const message = orderNoticeContent("received", reference, privateUrl, true, "AWAITING_VERIFICATION");
  assert.equal(message.kind, "order-confirmation");
  assert.match(message.subject, /^\[Test order\] We received your order/);
  assert.doesNotMatch(message.subject, /access=|synthetic/);
  assert.match(message.text, /payment proof is awaiting verification/);
  assert.match(message.text, /works for seven days/);
  assert.ok(message.text.includes(privateUrl));
});

test("shipment notifications distinguish updates and keep signed-in purchases behind account sign-in", () => {
  const accountUrl = "https://dev.griipbuddy.com/bd/orders";
  const message = orderNoticeContent("out-for-delivery", reference, accountUrl, false);
  assert.equal(message.kind, "shipment-update");
  assert.match(message.text, /marked your test order out for delivery/);
  assert.ok(message.text.includes(`Sign in to view your order: ${accountUrl}`));
  assert.doesNotMatch(message.text, /access=|seven days/);
  const refused = orderNoticeContent("refused", reference, accountUrl, false);
  assert.match(refused.text, /delivery of your test order was refused/);
  assert.doesNotMatch(refused.text, /payment.*refunded/);
});
