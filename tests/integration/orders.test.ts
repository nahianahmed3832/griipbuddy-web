import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { guestOrder, recoverCheckout, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { adjustStock, advanceFulfillment, cancelOrder, collectCash, updatePrice } from "../../src/lib/staff/operations.ts";
import { pauseMarketCheckout } from "../../src/lib/staff/market-settings.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const guest = () => randomBytes(32).toString("hex");
const inputFor = (variantId = "v-tote-oat", quantity = 1): CheckoutDetails => ({
  marketId: "bd",
  items: [{ variantId, quantity }],
  customer: {
    name: "Test Shopper", phone: "01700000000", district: "dhaka", locality: "Dhanmondi",
    address: "Test delivery address", email: "shopper@example.test",
  },
  paymentMethod: "COD", deliveryMethod: "standard",
});

async function review(input: CheckoutDetails, shopper: string) {
  const result = await reviewCheckout(input, "bd", shopper);
  assert.equal(result.kind, "review");
  return { ...input, attemptId: result.attemptId, reviewToken: result.quote.reviewToken };
}

async function stock(variantId: string) {
  return (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
}

async function staff() {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const packer = await db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true } });
  return { owner: owner.userId, packer: packer.userId };
}

after(() => db.$disconnect());

test("owner can pause new orders without losing accepted orders or staff fulfillment", async () => {
  const { owner, packer } = await staff();
  const shopper = guest();
  const waitingShopper = guest();
  const policy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "bd" } });
  assert.equal(policy.enabled, true);
  const before = await stock("v-tote-oat");
  const input = inputFor();
  const acceptedPayload = await review(input, shopper);
  const waitingPayload = await review(input, waitingShopper);
  const accepted = await submitCheckout(acceptedPayload, "bd", shopper);
  assert.equal(accepted.kind, "placed");
  try {
    await assert.rejects(pauseMarketCheckout(packer, "bd"), /permission/);
    const audits = () => db.auditEvent.count({ where: { actorId: owner, action: "MARKET_SETTINGS_CHANGED", target: "bd" } });
    const previousAudits = await audits();
    await pauseMarketCheckout(owner, "bd");
    await pauseMarketCheckout(owner, "bd");
    assert.equal(await audits(), previousAudits + 1);
    assert.equal((await reviewCheckout(input, "bd", guest())).kind, "unavailable");
    assert.equal((await submitCheckout(waitingPayload, "bd", waitingShopper)).kind, "unavailable");
    assert.equal(await stock("v-tote-oat"), before - 1);
    assert.deepEqual(await submitCheckout(acceptedPayload, "bd", shopper), accepted);
    assert.deepEqual(await recoverCheckout(acceptedPayload.attemptId, shopper), accepted);
    assert.ok(await guestOrder(accepted.orderId, shopper));
    assert.equal(await guestOrder(accepted.orderId, waitingShopper), null);
    await advanceFulfillment(packer, accepted.orderId, { next: "PACKING" });
    assert.equal((await guestOrder(accepted.orderId, shopper))?.fulfillmentStatus, "PACKING");
  } finally {
    await db.checkoutPolicy.update({ where: { marketId: "bd" }, data: { enabled: policy.enabled, revision: { increment: 1 } } });
    await cancelOrder(owner, accepted.orderId);
  }
  assert.equal(await stock("v-tote-oat"), before);
});

test("database catalog shares stock across markets and keeps prices and eligibility separate", async () => {
  const [bd, us] = await Promise.all([catalog.listProducts({ marketId: "bd" }), catalog.listProducts({ marketId: "us" })]);
  assert.equal(bd.filter(({ id }) => id.startsWith("p-")).length, 24);
  assert.equal(us.filter(({ id }) => id.startsWith("p-")).length, 23);
  const [bdTote, usTote] = await Promise.all([
    catalog.resolveVariants(["v-tote-plum", "v-tote-oat"], "bd"),
    catalog.resolveVariants(["v-tote-plum", "v-tote-oat"], "us"),
  ]);
  const bdPlum = bdTote.find((item) => item.variantId === "v-tote-plum")?.offer;
  const usPlum = usTote.find((item) => item.variantId === "v-tote-plum")?.offer;
  assert.equal(bdPlum?.stock, usPlum?.stock);
  assert.equal(bdPlum?.currency, "BDT");
  assert.equal(usPlum?.currency, "USD");
  assert.equal(usTote.find((item) => item.variantId === "v-tote-oat"), undefined);
});

test("server ignores browser money and preserves a purchased snapshot after catalog edits", async () => {
  const shopper = guest();
  const variantId = "v-tote-oat";
  const before = await stock(variantId);
  const input = inputFor(variantId);
  const payload = await review(input, shopper);
  const order = await submitCheckout({
    ...payload, totalMinor: 1, shipping: 0, taxMinor: 0, paymentStatus: "COLLECTED",
    items: [{ variantId, quantity: 1, unitPriceMinor: 1 }],
  }, "bd", shopper);
  assert.equal(order.kind, "placed");
  assert.equal(await stock(variantId), before - 1);
  const saved = await guestOrder(order.orderId, shopper);
  assert.ok(saved);
  assert.equal(saved.subtotalMinor, 115000);
  assert.equal(saved.deliveryMinor, 8000);
  assert.equal(saved.taxMinor, 5750);
  assert.equal(saved.totalMinor, 128750);
  assert.equal(saved.payment?.status, "AWAITING_COLLECTION");
  assert.equal(saved.items[0].sku, "GB-TOTE-OAT");
  assert.equal(saved.items[0].unitPriceMinor, 115000);
  assert.equal(await guestOrder(order.orderId, guest()), null);
  const { owner } = await staff();
  try {
    await updatePrice(owner, { variantId, marketId: "bd", amountMinor: 125000, expectedMinor: 115000 });
    assert.equal((await guestOrder(order.orderId, shopper))?.items[0].unitPriceMinor, 115000);
    const found = await db.auditEvent.count({ where: { actorId: owner, target: variantId, action: "PRICE_CHANGED" } });
    assert.ok(found > 0);
  } finally {
    await updatePrice(owner, { variantId, marketId: "bd", amountMinor: 115000, expectedMinor: 125000 });
    await cancelOrder(owner, order.orderId);
  }
});

test("simultaneous double submission returns the same order and conflicting contents are rejected", async () => {
  const shopper = guest();
  const payload = await review(inputFor(), shopper);
  const before = await stock("v-tote-oat");
  const [first, second] = await Promise.all([submitCheckout(payload, "bd", shopper), submitCheckout(payload, "bd", shopper)]);
  assert.equal(first.kind, "placed");
  assert.deepEqual(first, second);
  assert.equal(await db.order.count({ where: { attemptId: payload.attemptId } }), 1);
  assert.equal(await stock("v-tote-oat"), before - 1);
  assert.equal((await submitCheckout({ ...payload, items: [{ variantId: "v-tote-oat", quantity: 2 }] }, "bd", shopper)).kind, "conflict");
  assert.equal((await submitCheckout(payload, "bd", guest())).kind, "conflict");
  assert.deepEqual(await recoverCheckout(payload.attemptId, shopper), first);
  const { owner } = await staff();
  await cancelOrder(owner, first.orderId);
});

test("two shoppers competing for the final unit cannot both create an order", async () => {
  const variantId = "v-lamp-cream";
  const firstGuest = guest();
  const secondGuest = guest();
  const before = await stock(variantId);
  await db.inventory.update({ where: { variantId }, data: { available: 1 } });
  try {
    const [first, second] = await Promise.all([review(inputFor(variantId), firstGuest), review(inputFor(variantId), secondGuest)]);
    const results = await Promise.all([submitCheckout(first, "bd", firstGuest), submitCheckout(second, "bd", secondGuest)]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ["placed", "unavailable"]);
    assert.equal(await db.order.count({ where: { attemptId: { in: [first.attemptId, second.attemptId] } } }), 1);
    assert.equal(await stock(variantId), 0);
    const { owner } = await staff();
    for (const result of results) if (result.kind === "placed") await cancelOrder(owner, result.orderId);
  } finally {
    await db.inventory.update({ where: { variantId }, data: { available: before } });
  }
});

test("rejects invalid quantities, duplicate lines, unknown delivery, invalid phone and US checkout", async () => {
  const shopper = guest();
  for (const quantity of [0, -1, 100, 1.25]) assert.equal((await reviewCheckout(inputFor("v-tote-oat", quantity), "bd", shopper)).kind, "invalid");
  const input = inputFor();
  assert.equal((await reviewCheckout({ ...input, items: [...input.items, ...input.items] }, "bd", shopper)).kind, "invalid");
  assert.equal((await reviewCheckout({ ...input, customer: { ...input.customer, district: "sylhet" } }, "bd", shopper)).kind, "unavailable");
  assert.equal((await reviewCheckout({ ...input, customer: { ...input.customer, phone: "12345" } }, "bd", shopper)).kind, "invalid");
  assert.equal((await reviewCheckout({ ...input, deliveryMethod: "unknown" }, "bd", shopper)).kind, "unavailable");
  assert.equal((await reviewCheckout({ ...input, marketId: "us" }, "us", shopper)).kind, "unavailable");
  const payload = await review(input, shopper);
  assert.equal((await submitCheckout({ ...payload, marketId: "us" }, "us", shopper)).kind, "unavailable");
  assert.equal((await submitCheckout({ ...payload, marketId: "us" }, "bd", shopper)).kind, "invalid");
  assert.equal(await db.order.count({ where: { attemptId: payload.attemptId } }), 0);
});

test("a price or delivery change requires a new confirmation before stock is allocated", async () => {
  const shopper = guest();
  const payload = await review(inputFor(), shopper);
  const before = await stock("v-tote-oat");
  const zone = { marketId_district_method: { marketId: "bd", district: "dhaka", method: "standard" } } as const;
  await db.deliveryZone.update({ where: zone, data: { chargeMinor: 9000 } });
  try {
    const changed = await submitCheckout(payload, "bd", shopper);
    assert.equal(changed.kind, "changed");
    assert.equal(changed.quote.deliveryMinor, 9000);
    assert.equal(changed.quote.totalMinor, 129750);
    assert.equal(await stock("v-tote-oat"), before);
    assert.equal(await db.order.count({ where: { attemptId: payload.attemptId } }), 0);
    const order = await submitCheckout({ ...payload, reviewToken: changed.quote.reviewToken }, "bd", shopper);
    assert.equal(order.kind, "placed");
    const { owner } = await staff();
    await cancelOrder(owner, order.orderId);
  } finally {
    await db.deliveryZone.update({ where: zone, data: { chargeMinor: 8000 } });
  }
});

test("a database write failure after decrement rolls back all stock and the order", async () => {
  const shopper = guest();
  const one = inputFor();
  const payload = await review({ ...one, items: [...one.items, { variantId: "v-tote-plum", quantity: 1 }] }, shopper);
  const variantIds = payload.items.map((item) => item.variantId);
  const before = await Promise.all(variantIds.map(stock));
  await db.$executeRawUnsafe(`CREATE FUNCTION test_reject_payment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'intentional test payment failure'; END; $$`);
  try {
    await db.$executeRawUnsafe('CREATE TRIGGER test_reject_payment BEFORE INSERT ON "Payment" FOR EACH ROW EXECUTE FUNCTION test_reject_payment()');
    try {
      await assert.rejects(submitCheckout(payload, "bd", shopper));
      assert.equal(await db.order.count({ where: { attemptId: payload.attemptId } }), 0);
      assert.deepEqual(await Promise.all(variantIds.map(stock)), before);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER test_reject_payment ON "Payment"');
    }
  } finally {
    await db.$executeRawUnsafe("DROP FUNCTION test_reject_payment()");
  }
  const retry = await submitCheckout(payload, "bd", shopper);
  assert.equal(retry.kind, "placed");
  const { owner } = await staff();
  await cancelOrder(owner, retry.orderId);
});

test("an abandoned attempt cannot place an order after recovery", async () => {
  const shopper = guest();
  const payload = await review(inputFor(), shopper);
  assert.equal((await recoverCheckout(payload.attemptId, guest())).kind, "conflict");
  assert.equal((await recoverCheckout(payload.attemptId, shopper)).kind, "abandoned");
  assert.equal((await submitCheckout(payload, "bd", shopper)).kind, "conflict");
  assert.equal(await db.order.count({ where: { attemptId: payload.attemptId } }), 0);
});

test("only an owner can cancel, and parallel cancellation restores stock once", async () => {
  const shopper = guest();
  const payload = await review(inputFor(), shopper);
  const before = await stock("v-tote-oat");
  const order = await submitCheckout(payload, "bd", shopper);
  assert.equal(order.kind, "placed");
  const { owner, packer } = await staff();
  await assert.rejects(cancelOrder(packer, order.orderId), /permission/);
  await assert.rejects(cancelOrder("unknown-user", order.orderId), /permission/);
  await Promise.all([cancelOrder(owner, order.orderId), cancelOrder(owner, order.orderId)]);
  assert.equal(await stock("v-tote-oat"), before);
  assert.equal(await db.fulfillmentEvent.count({ where: { orderId: order.orderId, type: "ORDER_CANCELLED" } }), 1);
  const saved = await guestOrder(order.orderId, shopper);
  assert.equal(saved?.status, "CANCELLED");
  assert.equal(saved?.payment?.status, "VOIDED");
});

test("packing transitions are enforced and delivery never collects COD automatically", async () => {
  const shopper = guest();
  const payload = await review(inputFor("v-lamp-cream"), shopper);
  const order = await submitCheckout(payload, "bd", shopper);
  assert.equal(order.kind, "placed");
  const { owner, packer } = await staff();
  await assert.rejects(advanceFulfillment("unknown-user", order.orderId, { next: "PACKING" }), /permission/);
  await assert.rejects(advanceFulfillment(packer, order.orderId, { next: "SHIPPED" }), /no longer available/);
  await assert.rejects(adjustStock(packer, { variantId: "v-lamp-cream", delta: 1, reason: "Integration test" }), /permission/);
  await assert.rejects(updatePrice(packer, { variantId: "v-lamp-cream", marketId: "bd", expectedMinor: 298000, amountMinor: 299000 }), /permission/);
  await advanceFulfillment(packer, order.orderId, { next: "PACKING" });
  await advanceFulfillment(packer, order.orderId, { next: "READY_TO_SHIP" });
  await assert.rejects(advanceFulfillment(packer, order.orderId, { next: "SHIPPED" }), /tracking reference/);
  await advanceFulfillment(packer, order.orderId, { next: "SHIPPED", carrier: "Demo carrier", trackingReference: "DEMO-REF" });
  await assert.rejects(cancelOrder(owner, order.orderId), /unshipped/);
  await advanceFulfillment(packer, order.orderId, { next: "DELIVERED" });
  assert.equal((await guestOrder(order.orderId, shopper))?.payment?.status, "AWAITING_COLLECTION");
  await assert.rejects(collectCash(packer, order.orderId), /permission/);
  await collectCash(owner, order.orderId);
  assert.equal((await guestOrder(order.orderId, shopper))?.payment?.status, "COLLECTED");
  assert.equal(await db.fulfillmentEvent.count({ where: { orderId: order.orderId, actorId: packer } }), 4);
  const before = await stock("v-lamp-cream");
  await adjustStock(owner, { variantId: "v-lamp-cream", delta: 1, reason: "Integration test" });
  assert.equal(await stock("v-lamp-cream"), before + 1);
  assert.ok(await db.auditEvent.count({ where: { actorId: owner, target: "v-lamp-cream", action: "STOCK_CHANGED" } }));
});
