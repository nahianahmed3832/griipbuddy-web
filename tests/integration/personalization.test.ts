import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { guestOrder, recoverCheckout, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import { cancelOrder } from "../../src/lib/staff/operations.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("different personalization for one SKU keeps separate snapshots and shares stock", async () => {
  const previousMode = process.env.GRIIP_MARKETPLACE_PREVIEW;
  const variantId = "v-tote-oat";
  const original = await db.variant.findUniqueOrThrow({
    where: { id: variantId },
    include: { product: true, inventory: true },
  });
  assert.ok(original.inventory);
  const originalStock = original.inventory.available;
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const guest = randomBytes(32).toString("hex");
  const stock = async () => (await db.inventory.findUniqueOrThrow({ where: { variantId } })).available;
  let orderId: string | undefined;
  process.env.GRIIP_MARKETPLACE_PREVIEW = "1";
  try {
    await db.product.update({ where: { id: original.productId }, data: {
      personalizationPrompt: "Enter the name to embroider",
      personalizationRequired: true,
    } });
    await db.inventory.update({ where: { variantId }, data: { available: 2 } });
    const input: CheckoutDetails = {
      marketId: "bd",
      items: [
        { variantId, quantity: 1, personalization: "Zara" },
        { variantId, quantity: 1, personalization: "Arif" },
      ],
      customer: { name: "Test Shopper", phone: "01700000000", district: "dhaka",
        locality: "Dhanmondi", address: "Test delivery address" },
      paymentMethod: "COD",
      deliveryMethod: "standard",
    };
    const missing = await reviewCheckout({ ...input, items: [{ variantId, quantity: 1 }] }, "bd", guest);
    assert.equal(missing.kind, "unavailable");
    assert.match(missing.issues?.join(" ") ?? "", /personalization/);
    const overStock = await reviewCheckout({ ...input, items: [{ ...input.items[0], quantity: 2 }, input.items[1]] }, "bd", guest);
    assert.equal(overStock.kind, "unavailable");
    assert.match(overStock.issues?.join(" ") ?? "", /2 available, 3 requested/);
    const review = await reviewCheckout(input, "bd", guest);
    assert.equal(review.kind, "review");
    assert.deepEqual(review.quote.lines.map(line => line.personalization), ["Arif", "Zara"]);
    const payload = { ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken };
    const changed = await submitCheckout({ ...payload, items: [{ ...input.items[0], personalization: "Different" }, input.items[1]] }, "bd", guest);
    assert.equal(changed.kind, "conflict");
    const placed = await submitCheckout(payload, "bd", guest);
    assert.equal(placed.kind, "placed");
    orderId = placed.orderId;
    assert.deepEqual(await submitCheckout(payload, "bd", guest), placed);
    assert.deepEqual(await recoverCheckout(review.attemptId, guest), placed);
    assert.equal(await stock(), 0);
    await db.product.update({ where: { id: original.productId }, data: { personalizationPrompt: null, personalizationRequired: false } });
    assert.deepEqual((await guestOrder(placed.orderId, guest))?.items.map(line => line.personalization), ["Arif", "Zara"]);
    await cancelOrder(owner.userId, placed.orderId);
    assert.equal(await stock(), 2);
  } finally {
    if (orderId) await cancelOrder(owner.userId, orderId);
    await db.product.update({ where: { id: original.productId }, data: {
      personalizationPrompt: original.product.personalizationPrompt,
      personalizationRequired: original.product.personalizationRequired,
    } });
    await db.inventory.update({ where: { variantId }, data: { available: originalStock } });
    if (previousMode === undefined) delete process.env.GRIIP_MARKETPLACE_PREVIEW;
    else process.env.GRIIP_MARKETPLACE_PREVIEW = previousMode;
  }
});
