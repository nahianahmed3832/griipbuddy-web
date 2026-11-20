import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { adminHubDetail, adminHubPage, runAdminHubCommand, runSellerHubCommand,
  sellerHubDetail, sellerHubPage, SellerHubError } from "../../src/lib/marketplace/seller-hub.ts";
import { getSellerAccess } from "../../src/lib/marketplace/seller-access.ts";
import { runSellerTeamCommand, sellerTeamPage } from "../../src/lib/marketplace/seller-team.ts";
import { advanceSellerPreparation, SellerOrderError } from "../../src/lib/marketplace/seller-orders.ts";
import { applyMarketplaceCommand, MarketplaceError } from "../../src/lib/marketplace/write.ts";
import { buyerSupportThread, sellerBuyerThreads } from "../../src/lib/marketplace/buyer-support.ts";
import { sellerStockAccess } from "../../src/lib/marketplace/seller-stock.ts";
import type { MarketId } from "../../src/config/markets.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const originalPreview = process.env.GRIIP_MARKETPLACE_PREVIEW;
before(() => { process.env.GRIIP_MARKETPLACE_PREVIEW = "1"; });
after(async () => {
  if (originalPreview === undefined) delete process.env.GRIIP_MARKETPLACE_PREVIEW;
  else process.env.GRIIP_MARKETPLACE_PREVIEW = originalPreview;
  await db.$disconnect();
});

const hubStatus = (status: number) => (error: unknown) => error instanceof SellerHubError && error.status === status;
const messageStatus = (status: number) => (error: unknown) => error instanceof MarketplaceError && error.status === status;
const orderStatus = (status: number) => (error: unknown) => error instanceof SellerOrderError && error.status === status;
const operation = <T extends object>(body: T) => ({ ...body, operationId: randomUUID() });

async function fixture(run: (data: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const data = await createFixture();
  try { await run(data); } finally {
    const shops = [data.shop, data.foreignShop];
    const shoppers = [data.buyer, data.owner, data.member, data.outsider, data.otherOwner];
    await db.shopperRequest.deleteMany({ where: { shopId: { in: shops } } });
    const orders = await db.order.findMany({ where: { shopperId: data.buyer }, select: { id: true } });
    const orderId = { in: orders.map(order => order.id) };
    await db.orderItem.deleteMany({ where: { orderId } });
    await db.payment.deleteMany({ where: { orderId } });
    await db.order.deleteMany({ where: { shopperId: data.buyer } });
    await db.checkoutAttempt.deleteMany({ where: { id: data.attempt } });
    await db.dispatchLocation.deleteMany({ where: { shopId: { in: shops } } });
    await db.marketplaceCoupon.deleteMany({ where: { code: data.coupon } });
    await db.auditEvent.deleteMany({ where: { OR: [{ actorId: { in: [data.staff, data.packer] } },
      { target: { in: [...shops, ...data.records] } }] } });
    await db.sellerHubRecord.deleteMany({ where: { OR: [{ shopId: { in: shops } }, { id: { in: data.records } }] } });
    await db.sellerHubOperation.deleteMany({ where: { actorKey: {
      in: [...shoppers.flatMap(id => [`seller:${id}`, `support:seller:${id}`, `support:buyer:${id}`]), `staff:${data.staff}`],
    } } });
    await db.marketplaceShop.deleteMany({ where: { id: { in: shops } } });
    await db.user.deleteMany({ where: { id: { in: [data.staff, data.packer] } } });
    await db.shopper.deleteMany({ where: { id: { in: shoppers } } });
  }
}

async function createFixture() {
  const [owner, member, outsider, buyer, otherOwner, shop, foreignShop, staff, packer, attempt] = Array.from({ length: 10 }, randomUUID);
  await db.shopper.createMany({ data: [owner, member, outsider, buyer, otherOwner].map(id => ({
    id, email: `${id}@example.invalid`, name: "Synthetic Hub actor", emailVerified: true,
  })) });
  await db.marketplaceShop.create({ data: {
    id: shop, ownerId: owner, name: "Synthetic first shop", slug: `synthetic-first-${shop}`, about: "",
    announcement: "", published: true, marketGrants: { create: [{ marketId: "bd", status: "APPROVED" }, { marketId: "us", status: "APPROVED" }] },
  } });
  await db.marketplaceShop.create({ data: {
    id: foreignShop, ownerId: otherOwner, name: "Synthetic other shop", slug: `synthetic-other-${foreignShop}`, about: "",
    announcement: "", published: true, marketGrants: { create: [{ marketId: "bd", status: "APPROVED" }] },
  } });
  await db.user.create({ data: { id: staff, name: "Synthetic Hub owner", email: `${staff}@example.invalid`, emailVerified: true,
    staff: { create: { role: "OWNER" } } } });
  await db.user.create({ data: { id: packer, name: "Synthetic Hub packer", email: `${packer}@example.invalid`, emailVerified: true,
    staff: { create: { role: "PACKER" } } } });
  const coupon = `HUB-${shop.slice(0, 8).toUpperCase()}`;
  await db.marketplaceCoupon.create({ data: { code: coupon, marketId: "bd", kind: "FIXED", value: 100, shopId: shop } });
  return { owner, member, outsider, buyer, otherOwner, shop, foreignShop, staff, packer, attempt, coupon, records: [] as string[] };
}

test("the Hub scopes notices, requests, campaigns and Marketplace conversations to the authorized recipient", async () => fixture(async data => {
  const actor = { id: data.staff, role: "OWNER" as const };
  const ownerScope = { shopperId: data.owner, shopId: data.shop, marketId: "bd" as const };
  const foreignScope = { shopperId: data.otherOwner, shopId: data.foreignShop, marketId: "bd" as const };
  const usScope = { ...ownerScope, marketId: "us" as const };
  const publish = <T extends object>(fields: T) => runAdminHubCommand(actor, "bd",
    operation({ action: "notice.publish", title: "Synthetic notice", body: "Fixture body", ...fields }));
  const platform = await publish({ scope: "PLATFORM" });
  const market = await publish({ scope: "MARKET" });
  const privateNotice = await publish({ scope: "SHOP", shopId: data.shop });
  data.records.push(platform.id, market.id, privateNotice.id);
  const ownerItems = await sellerHubPage(ownerScope, "notices");
  assert.deepEqual(new Set(ownerItems.rows.filter(row => data.records.includes(row.id)).map(row => row.id)), new Set(data.records));
  assert.deepEqual(new Set((await sellerHubPage(foreignScope, "notices")).rows.filter(row => data.records.includes(row.id)).map(row => row.id)), new Set([platform.id, market.id]));
  assert.deepEqual((await sellerHubPage(usScope, "notices")).rows.filter(row => data.records.includes(row.id)).map(row => row.id), [platform.id]);
  assert.equal(await sellerHubDetail(foreignScope, privateNotice.id), null);
  assert.equal(await sellerHubDetail(usScope, market.id), null);
  assert.equal(await adminHubDetail("us", privateNotice.id), null);
  assert.ok((await adminHubPage("us", "notices")).rows.some(row => row.id === platform.id));
  await assert.rejects(runAdminHubCommand({ id: data.packer, role: "OWNER" }, "bd",
    operation({ action: "notice.publish", title: "Unauthorized", body: "Unauthorized", scope: "MARKET" })), hubStatus(403));
  const ack = operation({ action: "notice.acknowledge", id: privateNotice.id, shopId: data.shop });
  const acked = await Promise.all([runSellerHubCommand(data.owner, "bd", ack), runSellerHubCommand(data.owner, "bd", ack)]);
  assert.deepEqual(acked.map(row => row.id), [privateNotice.id, privateNotice.id]);
  assert.ok((await sellerHubDetail(ownerScope, privateNotice.id))?.acknowledged);
  assert.ok(!(await sellerHubDetail(foreignScope, platform.id))?.acknowledged);
  assert.equal(await db.sellerHubRead.count({ where: { recordId: privateNotice.id } }), 1);

  const categoryCount = await db.department.count();
  const request = operation({ action: "request.submit", shopId: data.shop, category: "CATEGORY", title: "Synthetic category request", body: "Review intake" });
  const submitted = await runSellerHubCommand(data.owner, "bd", request);
  await assert.rejects(runSellerHubCommand(data.owner, "bd", { ...request, body: "Changed content" }), hubStatus(409));
  await assert.rejects(runAdminHubCommand(actor, "us", operation({ action: "request.review", id: submitted.id,
    decision: "ACCEPTED", note: "Outside scope" })), hubStatus(404));
  await runAdminHubCommand(actor, "bd", operation({ action: "request.review", id: submitted.id, decision: "ACCEPTED", note: "Catalog review still pending" }));
  assert.equal((await sellerHubDetail(ownerScope, submitted.id))?.status, "ACCEPTED");
  assert.equal(await db.department.count(), categoryCount);

  const invite = { action: "campaign.invite", shopId: data.shop, title: "Synthetic code invitation", body: "Record interest", reference: data.coupon };
  await assert.rejects(runAdminHubCommand(actor, "us", operation(invite)), hubStatus(409));
  await assert.rejects(runAdminHubCommand(actor, "bd", operation({ ...invite, shopId: data.foreignShop })), hubStatus(409));
  const invitation = await runAdminHubCommand(actor, "bd", operation(invite));
  const response = operation({ action: "campaign.respond", shopId: data.shop, id: invitation.id, decision: "ACCEPTED" });
  const couponBefore = await db.marketplaceCoupon.findUnique({ where: { code: data.coupon } });
  await db.marketplaceCoupon.update({ where: { code: data.coupon }, data: { enabled: false } });
  await assert.rejects(runSellerHubCommand(data.owner, "bd", response), hubStatus(409));
  await db.marketplaceCoupon.update({ where: { code: data.coupon }, data: { enabled: true } });
  await runSellerHubCommand(data.owner, "bd", response);
  assert.deepEqual(await db.marketplaceCoupon.findUnique({ where: { code: data.coupon } }), couponBefore);
  assert.equal((await sellerHubDetail(ownerScope, invitation.id))?.response, "ACCEPTED");

  const thread = await runAdminHubCommand(actor, "bd", operation({ action: "conversation.start", shopId: data.shop,
    title: "Private fixture", text: "Staff message" }));
  assert.equal(await sellerHubDetail(foreignScope, thread.id), null);
  await assert.rejects(runSellerHubCommand(data.otherOwner, "bd", operation({ action: "conversation.reply",
    shopId: data.foreignShop, id: thread.id, text: "Cross-shop" })), hubStatus(404));
  await runSellerHubCommand(data.owner, "bd", operation({ action: "record.read", shopId: data.shop, id: thread.id }));
  assert.equal((await sellerHubDetail(ownerScope, thread.id))?.seen, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  const reply = operation({ action: "conversation.reply", id: thread.id, text: "Staff reply" });
  await runAdminHubCommand(actor, "bd", reply);
  await runAdminHubCommand(actor, "bd", reply);
  const result = await sellerHubDetail(ownerScope, thread.id);
  assert.equal(result?.seen, false);
  assert.deepEqual(result?.posts.map(row => row.text), ["Staff message", "Staff reply"]);
}));

test("delegate invitation, order preparation and buyer support preserve market, shop and permission boundaries", async () => fixture(async data => {
  const { owner, member, shop, foreignShop, otherOwner, buyer, outsider } = data;
  const permission = operation({ action: "team.invite", shopId: shop, email: `${member}@example.invalid`,
    permissions: ["SUPPORT", "ORDER_PREPARATION", "LISTINGS", "FINANCE_VIEW"] });
  await runSellerTeamCommand(owner, "bd", permission);
  assert.equal((await sellerTeamPage(member, "bd")).invitations[0]?.shopId, shop);
  assert.equal((await sellerTeamPage(member, "us")).invitations.length, 0);
  assert.equal(await getSellerAccess(member, shop, "bd", "SUPPORT"), null);
  await assert.rejects(runSellerTeamCommand(outsider, "bd", operation({ action: "team.accept", shopId: shop })), hubStatus(404));
  await assert.rejects(runSellerTeamCommand(member, "us", operation({ action: "team.accept", shopId: shop })), hubStatus(404));
  const accept = operation({ action: "team.accept", shopId: shop });
  assert.deepEqual(await Promise.all([runSellerTeamCommand(member, "bd", accept), runSellerTeamCommand(member, "bd", accept)]),
    [{ id: member }, { id: member }]);
  assert.equal((await getSellerAccess(member, shop, "bd", "FINANCE_VIEW"))?.owner, false);
  assert.equal(await getSellerAccess(member, shop, "bd", "PAYOUT_DESTINATION"), null);
  assert.equal(await getSellerAccess(member, shop, "bd", "PAYOUT_REQUEST"), null);
  assert.equal(await getSellerAccess(member, shop, "bd", "PROFILE"), null);
  assert.equal(await getSellerAccess(member, foreignShop, "bd", "ORDER_PREPARATION"), null);
  await assert.rejects(runSellerTeamCommand(member, "bd", operation({ action: "team.invite", shopId: shop,
    email: `${outsider}@example.invalid`, permissions: ["SUPPORT"] })), hubStatus(404));

  const allowedStock = await sellerStockAccess(db, member, "bd");
  assert.deepEqual(allowedStock.location.marketId, { in: ["bd"] });
  assert.equal(allowedStock.location.shopId, shop);
  const variant = await db.variant.findFirstOrThrow({ select: { id: true } });
  const orderId = randomUUID();
  await db.checkoutAttempt.create({ data: { id: data.attempt, guestKey: randomBytes(32).toString("hex"), requestHash: randomBytes(32).toString("hex") } });
  await db.order.create({ data: {
    id: orderId, attemptId: data.attempt, shopperId: buyer, reference: `HUB-${orderId}`, marketId: "bd", currency: "BDT",
    customerName: "Sensitive fixture", phone: "01000000000", district: "dhaka", districtLabel: "Dhaka",
    locality: "Fixture", address: "Private fixture address", deliveryMethod: "standard", deliveryLabel: "Standard",
    taxLabel: "Tax", subtotalMinor: 1000, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor: 1000,
    payment: { create: { method: "COD", status: "AWAITING_COLLECTION", amountMinor: 1000, currency: "BDT" } },
    items: { create: { variantId: variant.id, marketplaceShopId: shop, productName: "Synthetic purchase", sku: "SYNTHETIC",
      variantName: "Standard", quantity: 1, unitPriceMinor: 1000, unitDiscountMinor: 0, lineTotalMinor: 1000, currency: "BDT" } },
  } });
  await assert.rejects(advanceSellerPreparation(member, { orderId, shopId: foreignShop, marketId: "bd", next: "PREPARING" }), orderStatus(404));
  await assert.rejects(advanceSellerPreparation(member, { orderId, shopId: shop, marketId: "us", next: "PREPARING" }), orderStatus(404));
  assert.deepEqual(await advanceSellerPreparation(member, { orderId, shopId: shop, marketId: "bd", next: "PREPARING" }),
    { status: "PREPARING" });

  const request = operation({ action: "open-message" as const, shop, order: orderId, subject: "Synthetic order question", text: "Private order message" });
  await assert.rejects(applyMarketplaceCommand({ ...request, shop: foreignShop }, { shopperId: buyer, marketId: "bd" }), messageStatus(404));
  await assert.rejects(applyMarketplaceCommand(request, { shopperId: outsider, marketId: "bd" }), messageStatus(404));
  const purchaser = { shopperId: buyer, marketId: "us" as MarketId };
  const opened = await applyMarketplaceCommand(request, purchaser);
  const thread = "id" in opened ? opened.id : null;
  assert.equal(typeof thread, "string");
  assert(typeof thread === "string");
  data.records.push(thread);
  assert.deepEqual(await applyMarketplaceCommand(request, purchaser), opened);
  assert.equal(await db.shopperMessage.count({ where: { requestId: thread } }), 1);
  assert.equal((await db.shopperRequest.findUnique({ where: { id: thread } }))?.marketId, "bd");
  assert.ok(await buyerSupportThread(thread, { shopperId: member, marketId: "bd" }));
  assert.equal(await buyerSupportThread(thread, { shopperId: member, marketId: "us" }), null);
  assert.equal(await buyerSupportThread(thread, { shopperId: otherOwner, marketId: "bd" }), null);
  assert.equal(await buyerSupportThread(thread, { shopperId: outsider, marketId: "bd" }), null);
  assert.doesNotMatch(JSON.stringify(await buyerSupportThread(thread, { shopperId: member, marketId: "bd" })), /Private fixture address|010000/);
  assert.deepEqual((await sellerBuyerThreads(member, "bd"))?.rows.map(row => row.id), [thread]);
  const reply = operation({ action: "reply" as const, thread, text: "Authorized support reply" });
  await applyMarketplaceCommand(reply, { shopperId: member, marketId: "bd" });
  await applyMarketplaceCommand(reply, { shopperId: member, marketId: "bd" });
  assert.equal(await db.shopperMessage.count({ where: { requestId: thread } }), 2);

  await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: shop, marketId: "bd" } }, data: { status: "DENIED" } });
  assert.equal(await getSellerAccess(member, shop, "bd", "SUPPORT"), null);
  assert.equal(await buyerSupportThread(thread, { shopperId: member, marketId: "bd" }), null);
  assert.ok(await buyerSupportThread(thread, { shopperId: buyer, marketId: "us" }));
  await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: shop, marketId: "bd" } }, data: { status: "APPROVED" } });
  await runSellerTeamCommand(owner, "bd", operation({ action: "team.revoke", shopId: shop, memberId: member }));
  await assert.rejects(applyMarketplaceCommand(reply, { shopperId: member, marketId: "bd" }), messageStatus(404));
  await assert.rejects(advanceSellerPreparation(member, { orderId, shopId: shop, marketId: "bd", next: "READY" }), orderStatus(404));
}));
