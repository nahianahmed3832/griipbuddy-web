import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import sharp from "sharp";
import "../../scripts/load-env.ts";
import { getConnectedProduct } from "../../src/lib/catalog/connected-product.ts";
import { saveConnectedOffer } from "../../src/lib/commerce/market-offers.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import {
  reviewSellerListing, reviewerListingQueue, saveSellerListing, sellerListingReview, storeSellerListingImage, validateSellerListingDraft,
} from "../../src/lib/marketplace/listing-review.ts";
import { setWorkspaceProductPublication } from "../../src/lib/staff/product-publication.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("reviewed seller publication is market-scoped, revision-safe, and preserves historic SKU and offer identity", async t => {
  const id = randomBytes(5).toString("hex");
  const departmentId = `m04-${id}-dept`;
  const categoryId = `m04-${id}-category`;
  const subcategoryId = `m04-${id}-subcategory`;
  const ownerId = randomUUID();
  const bdReviewerId = randomUUID();
  const sellerId = randomUUID();
  const otherSellerId = randomUUID();
  const shopId = randomUUID();
  const otherShopId = randomUUID();
  const orderId = randomUUID();
  const attemptId = randomUUID();
  const operationId = randomUUID();
  const fixture: { productId?: string; photoId?: string } = {};
  const previous = { GRIIP_MARKETPLACE_PREVIEW: process.env.GRIIP_MARKETPLACE_PREVIEW,
    GRIIP_FIRST_PARTY_STOREFRONT: process.env.GRIIP_FIRST_PARTY_STOREFRONT };
  Object.assign(process.env, { GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_FIRST_PARTY_STOREFRONT: "0" });

  t.after(async () => {
    const { productId, photoId } = fixture;
    if (productId) {
      await db.orderItem.deleteMany({ where: { orderId } });
      await db.order.deleteMany({ where: { id: orderId } });
      await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
      await db.marketOffer.deleteMany({ where: { variant: { productId } } });
      await db.marketOfferIdentity.deleteMany({ where: { variant: { productId } } });
      await db.variantOptionSelection.deleteMany({ where: { productId } });
      await db.variant.deleteMany({ where: { productId } });
      await db.sellerListingReview.deleteMany({ where: { productId } });
      await db.product.deleteMany({ where: { id: productId } });
      await db.auditEvent.deleteMany({ where: { target: productId } });
    }
    await db.sellerListingAsset.deleteMany({ where: { shopId } });
    if (photoId) await db.catalogMedia.deleteMany({ where: { id: photoId } });
    await db.marketplaceShop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
    await db.shopper.deleteMany({ where: { id: { in: [sellerId, otherSellerId] } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, bdReviewerId] } } });
    for (const id of [subcategoryId, categoryId, departmentId]) await db.department.deleteMany({ where: { id } });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  for (const [entryId, kind, parentId] of [
    [departmentId, "DEPARTMENT", null], [categoryId, "CATEGORY", departmentId], [subcategoryId, "SUBCATEGORY", categoryId],
  ] as const) {
    await db.department.create({ data: {
      id: entryId, slug: entryId, name: `Fixture ${kind}`, shortName: kind, description: "",
      imageSrc: "/catalog/phone-stand.webp", imageAlt: "Fixture", position: 9999, kind, parentId,
    } });
  }
  for (const user of [ownerId, bdReviewerId]) await db.user.create({ data: {
    id: user, name: "Fixture Reviewer", email: `${user}@example.invalid`, staff: { create: {
      role: user === ownerId ? "OWNER" : "PACKER",
      ...(user === bdReviewerId && { marketGrants: { create: { marketId: "bd", merchandising: true } } }),
    } },
  } });
  for (const [shop, shopper] of [[shopId, sellerId], [otherShopId, otherSellerId]]) {
    await db.shopper.create({ data: { id: shopper, name: "Fixture Seller", email: `${shopper}@example.invalid` } });
    await db.marketplaceShop.create({ data: {
      id: shop, ownerId: shopper, slug: `fixture-${shop}`, name: "Fixture Market Shop", about: "", announcement: "", published: true,
      marketGrants: { create: { marketId: "bd", status: "APPROVED" } },
    } });
  }

  const bytes = await sharp(randomBytes(12), { raw: { width: 2, height: 2, channels: 3 } }).webp().toBuffer();
  const photo = await storeSellerListingImage(sellerId, "bd", bytes, "image/webp");
  fixture.photoId = photo.src.slice(7);
  const draft = {
    name: "Reviewed phone holder", description: "A synthetic product for market approval checks.", departmentId: subcategoryId,
    image: { ...photo, alt: "Fixture phone holder" },
    variants: [
      { sku: "BLUE", label: "Blue", options: { Color: "Blue" }, amountMinor: 1120, isDefault: true },
      { sku: "RED", label: "Red", options: { Color: "Red" }, amountMinor: 2025, isDefault: false },
    ],
  };
  await assert.rejects(validateSellerListingDraft(otherSellerId, "bd", draft), /Upload an image/);
  await assert.rejects(saveSellerListing(sellerId, { action: "save", marketId: "us", draft }), { status: 403 });
  await assert.rejects(saveSellerListing(sellerId, { action: "save", marketId: "bd", draft: {
    ...draft, variants: [draft.variants[0], { ...draft.variants[1], options: { Color: "blue" } }],
  } }), /different option combination/);
  const creation = { action: "save", marketId: "bd", operationId, draft };
  const bd = await saveSellerListing(sellerId, creation);
  const { productId } = bd;
  fixture.productId = productId;
  const product = await db.product.findUniqueOrThrow({ where: { id: productId } });
  const publicIn = (marketId: "bd" | "us") => getConnectedProduct(product.slug, { marketId, locale: marketId === "bd" ? "en-BD" : "en-US" });
  assert.deepEqual(await saveSellerListing(sellerId, creation), bd);
  await assert.rejects(saveSellerListing(sellerId, { ...creation, draft: { ...draft, name: "Different draft" } }), { status: 409 });
  assert.equal(await sellerListingReview(otherSellerId, productId, "bd"), null);
  await assert.rejects(saveSellerListing(otherSellerId, { action: "save", marketId: "bd", productId, draft }), { status: 404 });
  assert.equal(await publicIn("bd"), null);
  assert.equal(await publicIn("us"), null);

  const bdCommand = { productId, marketId: "bd" };
  const submit = await saveSellerListing(sellerId, { ...bdCommand, action: "submit", revision: bd.revision });
  const queue = await reviewerListingQueue(bdReviewerId, "bd", "Reviewed phone");
  assert.equal(queue.find(row => row.productId === productId)?.state, "SUBMITTED");
  await assert.rejects(reviewerListingQueue(bdReviewerId, "us"), { status: 403 });
  await assert.rejects(reviewSellerListing(otherSellerId, "bd", { productId, revision: submit.revision, decision: "approve" }), { status: 403 });
  await assert.rejects(reviewSellerListing(bdReviewerId, "bd", { productId, revision: submit.revision, decision: "reject" }), { status: 400 });
  const rejected = await reviewSellerListing(bdReviewerId, "bd", {
    productId, revision: submit.revision, decision: "reject", feedback: "Clarify the draft description.",
  });
  assert.equal(rejected.feedback, "Clarify the draft description.");
  assert.equal(await publicIn("bd"), null);
  await assert.rejects(reviewSellerListing(ownerId, "bd", { productId, revision: submit.revision, decision: "approve" }), { status: 409 });
  const revised = await saveSellerListing(sellerId, { ...bdCommand, action: "save", revision: rejected.revision, draft });
  const bdSubmitted = await saveSellerListing(sellerId, { ...bdCommand, action: "submit", revision: revised.revision });
  await assert.rejects(reviewSellerListing(bdReviewerId, "bd", {
    productId, revision: bdSubmitted.revision, decision: "publish",
  }), /Approve the current submission/);
  const bdApproved = await reviewSellerListing(bdReviewerId, "bd", { productId, revision: bdSubmitted.revision, decision: "approve" });
  assert.equal(bdApproved.state, "APPROVED");
  assert.equal((await reviewerListingQueue(bdReviewerId, "bd")).find(row => row.productId === productId)?.state, "APPROVED");
  assert.equal(await publicIn("bd"), null);
  assert.equal(await db.marketOffer.count({ where: { variant: { productId } } }), 0);
  await assert.rejects(reviewSellerListing(bdReviewerId, "bd", {
    productId, revision: bdSubmitted.revision, decision: "publish",
  }), { status: 409 });
  await db.marketplaceShopMarket.update({
    where: { shopId_marketId: { shopId, marketId: "bd" } }, data: { status: "DENIED" },
  });
  await assert.rejects(reviewSellerListing(bdReviewerId, "bd", { productId, revision: bdApproved.revision, decision: "publish" }), { status: 403 });
  assert.equal(await publicIn("bd"), null);
  await db.marketplaceShopMarket.update({
    where: { shopId_marketId: { shopId, marketId: "bd" } }, data: { status: "APPROVED" },
  });
  const bdPublished = await reviewSellerListing(bdReviewerId, "bd", { productId, revision: bdApproved.revision, decision: "publish" });
  assert.equal(bdPublished.state, "PUBLISHED");
  assert.equal((await reviewerListingQueue(bdReviewerId, "bd")).find(row => row.productId === productId), undefined);
  const [blue, red] = bdPublished.draft.variants;
  assert.ok(blue.id && red.id);
  const redId = red.id;
  const redOffer = await db.marketOffer.findUniqueOrThrow({ where: { variantId_marketId: { variantId: redId, marketId: "bd" } } });
  assert.ok(redOffer.offerId);
  const bdProduct = await publicIn("bd");
  assert.deepEqual(bdProduct?.variants.map(variant => variant.id), [blue.id, redId]);
  assert.equal(bdProduct?.variants[0].availability, "browse_only");
  assert.equal(await publicIn("us"), null);
  assert.equal(await db.inventoryPool.count({ where: { variant: { productId } } }), 0);
  const latestProduct = await db.product.findUniqueOrThrow({ where: { id: productId } });
  await assert.rejects(setWorkspaceProductPublication(ownerId, { productId, revision: latestProduct.revision, publication: "DRAFT" }), /market review/);
  await assert.rejects(saveConnectedOffer({ kind: "seller", id: sellerId }, {
    variantId: redId, marketId: "bd", sellerId: shopId, expectedRevision: redOffer.revision, amountMinor: 100,
    publication: "ACTIVE", eligible: true,
  }), /seller listing review/);

  await db.marketplaceShopMarket.create({ data: { shopId, marketId: "us", status: "APPROVED" } });
  const usDraft = { ...bdPublished.draft, variants: [{ ...blue, amountMinor: 890 }, { ...red, amountMinor: 1380 }] };
  const us = await saveSellerListing(sellerId, { action: "save", marketId: "us", productId, draft: usDraft });
  const usSubmitted = await saveSellerListing(sellerId, { action: "submit", marketId: "us", productId, revision: us.revision });
  await assert.rejects(reviewSellerListing(bdReviewerId, "us", { productId, revision: usSubmitted.revision, decision: "approve" }), { status: 403 });
  const usApproved = await reviewSellerListing(ownerId, "us", { productId, revision: usSubmitted.revision, decision: "approve" });
  assert.equal(await publicIn("us"), null);
  const usPublished = await reviewSellerListing(ownerId, "us", { productId, revision: usApproved.revision, decision: "publish" });
  assert.equal(usPublished.state, "PUBLISHED");
  assert.ok(await publicIn("us"));
  const prices = await db.marketOffer.findMany({ where: { variantId: redId }, orderBy: { marketId: "asc" } });
  assert.deepEqual(prices.map(({ marketId, currency, amountMinor }) => [marketId, currency, amountMinor]), [
    ["bd", "BDT", 2025], ["us", "USD", 1380],
  ]);

  const dangerous = await saveSellerListing(sellerId, {
    ...bdCommand, action: "save", revision: bdPublished.revision, draft: { ...bdPublished.draft, name: "Unreviewed new name" },
  });
  const pending = await saveSellerListing(sellerId, { ...bdCommand, action: "submit", revision: dangerous.revision });
  assert.equal((await publicIn("bd"))?.product.name, draft.name);
  assert.equal((await publicIn("us"))?.product.name, draft.name);
  await assert.rejects(reviewSellerListing(ownerId, "bd", { productId, revision: pending.revision, decision: "approve" }), /Another market is live/);

  await db.marketplaceShopMarket.update({
    where: { shopId_marketId: { shopId, marketId: "us" } }, data: { status: "DENIED" },
  });
  assert.equal(await publicIn("us"), null);
  assert.ok(await publicIn("bd"));
  const withdrawn = await saveSellerListing(sellerId, { action: "withdraw", marketId: "us", productId, revision: usPublished.revision });
  assert.equal(withdrawn.state, "WITHDRAWN");
  assert.equal(await publicIn("us"), null);
  assert.ok(await publicIn("bd"));

  await db.order.create({ data: {
    id: orderId, reference: `m04-history-${id}`, marketId: "bd", currency: "BDT", customerName: "Fixture Customer",
    phone: "01000000300", district: "dhaka", districtLabel: "Dhaka", locality: "Fixture", address: "Fixture address",
    deliveryMethod: "fixture", deliveryLabel: "Fixture delivery", taxLabel: "Fixture tax",
    subtotalMinor: 2025, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor: 2025, measurementTest: true,
    attempt: { create: { id: attemptId, marketId: "bd", paymentMethod: "COD", guestKey: randomBytes(32).toString("hex"),
      requestHash: randomBytes(32).toString("hex") } },
    items: { create: { variantId: redId, marketplaceShopId: shopId, productName: draft.name, sku: "ORIGINAL-SKU",
      variantName: "Red", quantity: 1, unitPriceMinor: 2025, unitDiscountMinor: 0, lineTotalMinor: 2025, currency: "BDT",
      offerIdSnapshot: redOffer.offerId } },
  } });
  const retiring = await saveSellerListing(sellerId, {
    ...bdCommand, action: "save", revision: pending.revision,
    draft: { ...bdPublished.draft, variants: [blue, { ...red, retired: true, amountMinor: null }] },
  });
  const retirement = await saveSellerListing(sellerId, { ...bdCommand, action: "submit", revision: retiring.revision });
  const retirementApproval = await reviewSellerListing(ownerId, "bd", { productId, revision: retirement.revision, decision: "approve" });
  assert.equal((await db.variant.findUniqueOrThrow({ where: { id: redId } })).active, true);
  await reviewSellerListing(ownerId, "bd", { productId, revision: retirementApproval.revision, decision: "publish" });
  assert.equal((await db.variant.findUniqueOrThrow({ where: { id: redId } })).active, false);
  assert.ok((await db.marketOfferIdentity.findUniqueOrThrow({ where: { id: redOffer.offerId } })).retiredAt);
  const history = await db.orderItem.findFirstOrThrow({ where: { orderId } });
  assert.deepEqual([history.variantId, history.offerIdSnapshot, history.lineTotalMinor, history.sku], [redId, redOffer.offerId, 2025, "ORIGINAL-SKU"]);
  assert.deepEqual((await publicIn("bd"))?.variants.map(variant => variant.id), [blue.id]);
  assert.ok((await db.auditEvent.count({ where: { target: productId, action: "PRODUCT_SAVED" } })) >= 10);
});
