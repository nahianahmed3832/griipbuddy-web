import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { comparisonHref, comparisonProducts } from "../../src/lib/catalog/comparison.ts";
import { getConnectedProduct } from "../../src/lib/catalog/connected-product.ts";
import { storeShop } from "../../src/lib/marketplace/constants.ts";
import { productQuestionShop, productReviews } from "../../src/lib/marketplace/product-engagement.ts";
import { applyMarketplaceCommand, MarketplaceError } from "../../src/lib/marketplace/write.ts";
import { buyerSupportThread } from "../../src/lib/marketplace/buyer-support.ts";
import { shopperSelections } from "../../src/lib/marketplace/data.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());
const failure = (status: number) => (error: unknown) => error instanceof MarketplaceError && error.status === status;

test("comparison references are bounded, normalized and market-bound", () => {
  assert.deepEqual(comparisonProducts(["close-view", "close-view", "?" , "wide-view", "third", "fourth"]), ["close-view", "wide-view", "third"]);
  assert.match(comparisonHref({ id: "us", locale: "en-US", regional: false }, ["close-view", "wide-view"]),
    /^\/compare\?product=close-view&product=wide-view&market=us&lang=en-US$/);
});

test("M10 scoped favorites, verified review moderation and product-linked support use the original records", async t => {
  const suffix = randomUUID().slice(0, 8);
  const product = `p-discovery-${suffix}`;
  const variant = `v-discovery-${suffix}`;
  const [buyer, stranger, seller, shop, staff, attemptId, orderId] = Array.from({ length: 7 }, randomUUID);
  t.after(async () => {
    await db.shopperRequest.deleteMany({ where: { shopperId: buyer } });
    await db.sellerHubOperation.deleteMany({ where: { actorKey: { in: [`support:buyer:${buyer}`, `support:seller:${seller}`] } } });
    await db.shopperFavorite.deleteMany({ where: { productId: product } });
    const reviewIds = (await db.shopperReview.findMany({ where: { orderId }, select: { id: true } })).map(row => row.id);
    await db.auditEvent.deleteMany({ where: { OR: [{ target: { in: reviewIds } },
      { changes: { path: ["productId"], equals: product } }] } });
    await db.shopperReview.deleteMany({ where: { orderId } });
    await db.orderItem.deleteMany({ where: { orderId } });
    await db.payment.deleteMany({ where: { orderId } });
    await db.order.deleteMany({ where: { id: orderId } });
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
    await db.marketOffer.deleteMany({ where: { variantId: variant } });
    await db.variant.deleteMany({ where: { id: variant } });
    await db.product.deleteMany({ where: { id: product } });
    await db.marketplaceShop.deleteMany({ where: { id: shop } });
    await db.shopper.deleteMany({ where: { id: { in: [buyer, stranger, seller] } } });
    await db.user.deleteMany({ where: { id: staff } });
  });
  await db.shopper.createMany({ data: [buyer, stranger, seller].map(id => ({ id, email: `${id}@example.invalid`, name: "Synthetic shopper" })) });
  await db.user.create({ data: { id: staff, email: `${staff}@example.invalid`, name: "Synthetic Core owner", staff: { create: { role: "OWNER" } } } });
  await db.marketplaceShop.create({ data: { id: shop, ownerId: seller, name: "Synthetic variant shop",
    slug: `discovery-${suffix}`, about: "", announcement: "", published: true,
    marketGrants: { create: [{ marketId: "bd", status: "APPROVED" }, { marketId: "us", status: "APPROVED" }] } } });
  const department = await db.department.findFirstOrThrow({ select: { id: true } });
  await db.product.create({ data: { id: product, slug: product, marketplaceShopId: shop, departmentId: department.id,
    name: "Synthetic market-only case", description: "A controlled fixture product.", specifications: [], keywords: ["market only case"],
    addedOn: new Date(), position: 1, publication: "ACTIVE", variants: { create: { id: variant, sku: variant, label: "Plain",
      options: {}, position: 0, offers: { create: { marketId: "bd", currency: "BDT", amountMinor: 73000, publication: "ACTIVE" } } } } } });
  assert.equal(await getConnectedProduct(product, { marketId: "us", locale: "en-US" }), null);
  const local = await getConnectedProduct(product, { marketId: "bd", locale: "en-BD" });
  assert.equal(local?.variants[0].offer.amountMinor, 73000);

  const bd = { shopperId: buyer, marketId: "bd" as const };
  const us = { shopperId: buyer, marketId: "us" as const };
  const favorite = { action: "favorite" as const, product, selected: true };
  await assert.rejects(applyMarketplaceCommand(favorite, us), failure(404));
  await applyMarketplaceCommand(favorite, bd);
  await applyMarketplaceCommand(favorite, bd);
  assert.deepEqual((await shopperSelections(buyer, "bd")).favorites, [product]);
  assert.deepEqual((await shopperSelections(stranger, "bd")).favorites, []);
  assert.deepEqual((await shopperSelections(buyer, "us")).favorites, []);

  const question = { action: "open-message" as const, shop, product, marketId: "bd" as const,
    operationId: randomUUID(), subject: "Fixture question", text: "Is the plain option textured?" };
  assert.equal((await productQuestionShop(product, "bd"))?.id, shop);
  assert.equal(await productQuestionShop(product, "us"), null);
  await assert.rejects(applyMarketplaceCommand({ ...question, shop: storeShop.id }, bd), failure(404));
  await assert.rejects(applyMarketplaceCommand(question, us), failure(409));
  const created = await applyMarketplaceCommand(question, bd);
  assert.ok("id" in created && typeof created.id === "string");
  const thread = created.id;
  assert.deepEqual(await applyMarketplaceCommand(question, bd), created);
  assert.equal(await db.shopperMessage.count({ where: { requestId: thread } }), 1);
  assert.equal((await buyerSupportThread(thread, bd))?.product?.name, "Synthetic market-only case");
  assert.equal(await buyerSupportThread(thread, us), null);
  assert.equal(await buyerSupportThread(thread, { ...bd, shopperId: stranger }), null);
  assert.equal(await buyerSupportThread(thread, { staffOwner: true, marketId: "bd" }), null);
  const reply = { action: "reply" as const, thread, text: "Yes. It has a textured grip.", operationId: randomUUID() };
  await assert.rejects(applyMarketplaceCommand(reply, { ...us, shopperId: seller }), failure(404));
  await applyMarketplaceCommand(reply, { ...bd, shopperId: seller });
  assert.equal((await buyerSupportThread(thread, bd))?.messages[0].text, reply.text);

  await db.checkoutAttempt.create({ data: { id: attemptId, requestHash: randomBytes(32).toString("hex"), guestKey: randomBytes(32).toString("hex") } });
  await db.order.create({ data: { id: orderId, attemptId, shopperId: buyer, reference: `M10-${suffix}`, marketId: "bd",
    currency: "BDT", fulfillmentStatus: "DELIVERED", customerName: "Synthetic buyer", phone: "01000000000", district: "dhaka", districtLabel: "Dhaka",
    locality: "Fixture", address: "Synthetic address", deliveryMethod: "standard", deliveryLabel: "Standard", measurementTest: true,
    taxLabel: "Tax", subtotalMinor: 73000, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor: 73000,
    payment: { create: { method: "COD", status: "COLLECTED", amountMinor: 73000, currency: "BDT" } },
    items: { create: { variantId: variant, marketplaceShopId: shop, productName: "Synthetic purchase", sku: variant,
      variantName: "Plain", quantity: 1, unitPriceMinor: 73000, unitDiscountMinor: 0, lineTotalMinor: 73000, currency: "BDT" } } } });
  const review = { action: "review" as const, order: orderId, product, marketId: "bd" as const, stars: 4, text: "A verified fixture review." };
  await assert.rejects(applyMarketplaceCommand(review, { ...bd, shopperId: stranger }), failure(404));
  await assert.rejects(applyMarketplaceCommand({ ...review, marketId: "us" }, bd), failure(404));
  await applyMarketplaceCommand(review, bd);
  assert.equal((await productReviews(product, "bd", "latest", 1)).total, 0);
  const moderation = (row: { id: string; updatedAt: Date }, visible: boolean) => ({
    action: "staff-review" as const, review: row.id, marketId: "bd" as const, visible, expectedUpdatedAt: row.updatedAt.toISOString(),
  });
  const row = await db.shopperReview.findFirstOrThrow({ where: { orderId } });
  const owner = { staffOwner: true, staffActorId: staff, marketId: "bd" as const };
  await assert.rejects(applyMarketplaceCommand(moderation(row, true), bd), failure(403));
  await assert.rejects(applyMarketplaceCommand({ ...moderation(row, true), marketId: "us" }, owner), failure(404));
  await applyMarketplaceCommand(moderation(row, true), owner);
  assert.equal((await productReviews(product, "bd", "highest", 1)).entries[0].text, review.text);
  assert.equal((await productReviews(product, "us", "highest", 1)).total, 0);
  await applyMarketplaceCommand(review, bd);
  assert.equal((await productReviews(product, "bd", "lowest", 1)).total, 1);
  await applyMarketplaceCommand({ ...review, text: "Changed review requires moderation." }, bd);
  await assert.rejects(applyMarketplaceCommand(moderation(row, true), owner), failure(409));
  assert.equal((await productReviews(product, "bd", "latest", 1)).total, 0);
});
