import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { cancelOrder } from "../../src/lib/staff/operations.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
const db = getDb();
after(() => db.$disconnect());

test("shop coupons are priced on the server and concurrent attempts cannot exceed the cap", async () => {
  const code = `TEST-${randomBytes(4).toString("hex").toUpperCase()}`;
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  await db.marketplaceCoupon.create({ data: { code, shopId: storeShop.id, kind: "FIXED", value: 1235, minimumMinor: 5000, useLimit: 1 } });

  try {
    const buyers = await Promise.all(["v-tote-oat", "v-tote-plum"].map(async variantId => {
      const input: CheckoutDetails = {
        marketId: "bd", items: [{ variantId, quantity: 1 }], couponCode: code.toLowerCase(),
        customer: { name: "Coupon test", phone: "01700000000", district: "dhaka", locality: "Dhaka", address: "Coupon test address" },
        paymentMethod: "COD", deliveryMethod: "standard",
      };
      const guestKey = randomBytes(32).toString("hex");
      const reviewed = await reviewCheckout(input, "bd", guestKey);
      assert.equal(reviewed.kind, "review");
      assert.equal(reviewed.quote.couponCode, code);
      assert.equal(reviewed.quote.couponDiscountMinor, 1235);
      assert.equal(reviewed.quote.lines[0].couponDiscountMinor, 1235);
      const payload = { ...input, attemptId: reviewed.attemptId, reviewToken: reviewed.quote.reviewToken };
      return { guestKey, payload };
    }));

    const results = await Promise.all(buyers.map(({ payload, guestKey }) => submitCheckout(payload, "bd", guestKey)));
    assert.deepEqual(results.map(result => result.kind).sort(), ["placed", "unavailable"]);
    const [saved] = await db.order.findMany({ where: { couponCode: code }, include: { items: true, payment: true } });
    assert.equal(saved.couponDiscountMinor, 1235);
    assert.equal(saved.items[0].lineTotalMinor, saved.subtotalMinor - saved.discountMinor);
    assert.equal(saved.payment?.amountMinor, saved.totalMinor);
    const winner = results.findIndex(result => result.kind === "placed");
    assert.deepEqual(await submitCheckout(buyers[winner].payload, "bd", buyers[winner].guestKey), results[winner]);
  } finally {
    const orders = await db.order.findMany({ where: { couponCode: code, status: "PLACED" }, select: { id: true } });
    for (const order of orders) await cancelOrder(owner.userId, order.id);
    await db.marketplaceCoupon.delete({ where: { code } });
  }
});
