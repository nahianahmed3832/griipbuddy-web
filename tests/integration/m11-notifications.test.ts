import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import type { MarketId } from "../../src/config/markets.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { markNotification, notificationInbox, NotificationError, setOrderNotifications } from "../../src/lib/notifications/inbox.ts";
import { notificationSandbox, queueTestNewsletter, retryTestDelivery, runNotificationTestJob } from "../../src/lib/notifications/test-delivery.ts";
import { whatsAppOrderInquiry, whatsAppProductInquiry } from "../../src/lib/notifications/whatsapp.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
const instant = new Date("2026-01-01T00:00:00.000Z");
const bdEmail = "notification-bd@example.invalid";
const usEmail = "notification-us@example.invalid";
Object.assign(process.env, {
  GRIIP_NOTIFICATION_TEST_MODE: "1",
  GRIIP_NOTIFICATION_TEST_EMAIL_BD: bdEmail,
  GRIIP_NOTIFICATION_TEST_EMAIL_US: usEmail,
  GRIIP_WHATSAPP_TEST_CONTACT_BD: "+12025550101",
});
const status = (expected: number) => (error: unknown) => error instanceof NotificationError && error.status === expected;

after(() => db.$disconnect());

async function shopper() {
  const id = randomUUID();
  return db.shopper.create({ data: { id, name: "Synthetic account", email: `${id}@example.invalid` } });
}

async function fixtureOrder(shopperId: string, marketId: MarketId, marketplaceShopId?: string) {
  const id = randomUUID();
  const currency = marketId === "bd" ? "BDT" : "USD";
  const variant = await db.variant.findFirstOrThrow({ select: { id: true } });
  const order = await db.order.create({ data: {
    id, reference: `M11-${id}`, marketId, shopper: { connect: { id: shopperId } }, currency, createdAt: instant, measurementTest: true,
    customerName: "Synthetic address owner", phone: "0000000000", email: "hidden@example.invalid", district: "Test",
    districtLabel: "Test", locality: "Test", address: "Unshared Synthetic Street", deliveryMethod: "test",
    deliveryLabel: "Test", taxLabel: "Test tax", subtotalMinor: 1000, discountMinor: 0, deliveryMinor: 0, taxMinor: 0, totalMinor: 1000,
    attempt: { create: { id: randomUUID(), marketId, guestKey: "M11-fixture", requestHash: id, createdAt: instant } },
    items: { create: { variant: { connect: { id: variant.id } }, productName: "Synthetic product", variantName: "Synthetic variant",
      sku: "m11-fixture-notification", marketplaceShopId, quantity: 1, unitPriceMinor: 1000, unitDiscountMinor: 0, lineTotalMinor: 1000, currency } },
  } });
  await db.fulfillmentEvent.createMany({ data: [
    { orderId: order.id, type: "ORDER_PLACED", status: "UNFULFILLED", createdAt: instant },
    { orderId: order.id, type: "STATUS_CHANGED", status: "PACKING", createdAt: new Date(+instant + 60_000) },
  ] });
  return order;
}

test("inbox projects order evidence once and keeps shopper, seller and staff market reads and receipts scoped", async t => {
  const [buyer, intruder, merchant] = await Promise.all([shopper(), shopper(), shopper()]);
  const [owner, packer] = await Promise.all([
    db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } }),
    db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true } }),
  ]);
  const shopId = randomUUID();
  await db.marketplaceShop.create({ data: {
    id: shopId, slug: `fixture-${shopId}`, name: "Synthetic shop", published: true, ownerId: merchant.id, about: "", announcement: "",
    marketGrants: { create: [{ marketId: "bd", status: "APPROVED" }] },
  } });
  const [bd, us] = await Promise.all([fixtureOrder(buyer.id, "bd", shopId), fixtureOrder(buyer.id, "us")]);
  t.after(async () => {
    await db.notificationInboxReceipt.deleteMany({ where: { actorId: { in: [buyer.id, merchant.id, owner.userId, packer.userId] } } });
    await db.notificationOrderPolicy.deleteMany();
    await db.auditEvent.deleteMany({ where: { target: "notifications:bd" } });
    await db.fulfillmentEvent.deleteMany({ where: { orderId: { in: [bd.id, us.id] } } });
    await db.orderItem.deleteMany({ where: { orderId: { in: [bd.id, us.id] } } });
    await db.order.deleteMany({ where: { id: { in: [bd.id, us.id] } } });
    await db.checkoutAttempt.deleteMany({ where: { id: { in: [bd.attemptId, us.attemptId] } } });
    await db.marketplaceShop.delete({ where: { id: shopId } });
    await db.shopper.deleteMany({ where: { id: { in: [buyer.id, intruder.id, merchant.id] } } });
  });
  const buyerBd = { audience: "customer", actorId: buyer.id, marketId: "bd" } as const;
  const sellerBd = { audience: "seller", actorId: merchant.id, marketId: "bd" } as const;
  const staffBd = { audience: "staff", actorId: owner.userId, marketId: "bd" } as const;
  const packerBd = { audience: "staff", actorId: packer.userId, marketId: "bd" } as const;
  assert.deepEqual((await notificationInbox(buyerBd)).map(row => row.title), ["Packing", "Order placed"]);
  assert.deepEqual((await notificationInbox({ ...buyerBd, marketId: "us" })).map(row => row.reference), [us.reference, us.reference]);
  assert.deepEqual((await notificationInbox(sellerBd)).map(row => row.title), ["Order placed"]);
  assert.deepEqual(await notificationInbox({ ...buyerBd, actorId: intruder.id }), []);
  await assert.rejects(notificationInbox({ ...sellerBd, marketId: "us" }), status(404));
  await assert.rejects(notificationInbox({ ...sellerBd, actorId: intruder.id }), status(404));
  await assert.rejects(notificationInbox({ ...packerBd, marketId: "us" }), status(404));
  assert.equal((await notificationInbox(packerBd)).filter(row => row.reference === bd.reference).length, 2);
  const orderKey = `order:${bd.id}`;
  await Promise.all([markNotification(buyerBd, orderKey, false, instant), markNotification(buyerBd, orderKey, false, instant)]);
  assert.equal((await notificationInbox(buyerBd)).find(row => row.key === orderKey)?.read, true);
  assert.equal((await notificationInbox(sellerBd))[0]?.read, false);
  await assert.rejects(markNotification({ ...buyerBd, actorId: intruder.id }, orderKey, true), status(404));
  await assert.rejects(markNotification({ ...buyerBd, marketId: "us" }, orderKey, true), status(404));
  await markNotification(buyerBd, orderKey, true, instant);
  assert.equal((await notificationInbox(buyerBd)).some(row => row.key === orderKey), false);
  assert.equal((await notificationInbox(staffBd)).some(row => row.key === orderKey), true);
  assert.equal(await db.notificationInboxReceipt.count({ where: { actorId: buyer.id, eventKey: orderKey } }), 1);
  const staff = JSON.stringify(await notificationInbox(staffBd));
  assert.doesNotMatch(staff, /hidden@example|Unshared Synthetic Street|0000000000/);
  await assert.rejects(setOrderNotifications(packer.userId, "bd", { placed: false, fulfillment: false }), status(403));
  await setOrderNotifications(owner.userId, "bd", { placed: false, fulfillment: true });
  assert.deepEqual((await notificationInbox(staffBd)).filter(row => row.reference === bd.reference).map(row => row.title), ["Packing"]);
  assert.equal((await notificationInbox({ ...staffBd, marketId: "us" })).filter(row => row.reference === us.reference).length, 2);
});

test("newsletter local sink enforces market opt-in, durable retry, exact replay and no duplicate acceptance", async t => {
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  const packer = await db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true } });
  t.after(async () => {
    await db.notificationTestJob.deleteMany();
    await db.newsletterRequest.deleteMany({ where: { email: { in: [bdEmail, usEmail] } } });
  });
  const draft = { operationId: randomUUID(), subject: "Synthetic newsletter", body: "Only stored in the fixture sink." };
  assert.equal(notificationSandbox(), true);
  await assert.rejects(queueTestNewsletter(owner.userId, "bd", draft, instant), status(409));
  await db.newsletterRequest.create({ data: { marketId: "bd", email: bdEmail, locale: "en-BD" } });
  await assert.rejects(queueTestNewsletter(owner.userId, "us", draft, instant), status(409));
  await assert.rejects(queueTestNewsletter(packer.userId, "bd", draft, instant), status(403));
  const [first, replay] = await Promise.all([
    queueTestNewsletter(owner.userId, "bd", draft, instant), queueTestNewsletter(owner.userId, "bd", draft, instant),
  ]);
  assert.deepEqual(replay, first);
  await assert.rejects(queueTestNewsletter(owner.userId, "bd", { ...draft, subject: "Changed" }, instant), status(409));
  assert.deepEqual(await runNotificationTestJob(instant, () => { throw new Error("Synthetic timeout"); }),
    { jobId: first.id, state: "RETRY_PENDING" });
  const early = new Date(+instant + 59_999);
  const due = new Date(+instant + 60_000);
  assert.equal(await runNotificationTestJob(early), null);
  const results = await Promise.all([runNotificationTestJob(due), runNotificationTestJob(due)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean)?.state, "SINK_ACCEPTED");
  const attempts = await db.notificationTestAttempt.findMany({ where: { jobId: first.id }, orderBy: { number: "asc" } });
  assert.deepEqual(attempts.map(attempt => attempt.outcome), ["RETRY_PENDING", "SINK_ACCEPTED"]);
  const sink = await db.notificationTestSink.findUniqueOrThrow({ where: { jobId: first.id } });
  assert.equal(sink.payloadHash, createHash("sha256").update(JSON.stringify(["en-BD", draft.subject, draft.body])).digest("hex"));
  assert.equal(await db.notificationTestSink.count({ where: { jobId: first.id } }), 1);
  await assert.rejects(retryTestDelivery(owner.userId, "bd", first.id, due), status(409));

  const second = await queueTestNewsletter(owner.userId, "bd", { ...draft, operationId: randomUUID() }, due);
  await db.newsletterRequest.delete({ where: { marketId_email: { marketId: "bd", email: bdEmail } } });
  assert.deepEqual(await runNotificationTestJob(due), { jobId: second.id, state: "FAILED" });
  assert.equal(await db.notificationTestSink.count({ where: { jobId: second.id } }), 0);
  await assert.rejects(retryTestDelivery(owner.userId, "bd", second.id, due), status(409));
  await db.newsletterRequest.create({ data: { marketId: "bd", email: bdEmail, locale: "en-BD" } });
  await assert.rejects(retryTestDelivery(owner.userId, "us", second.id, due), status(409));
  await retryTestDelivery(owner.userId, "bd", second.id, due);
  assert.deepEqual(await runNotificationTestJob(due), { jobId: second.id, state: "SINK_ACCEPTED" });
});

test("WhatsApp produces the isolated market draft only, including a clean same-origin product link or existing order reference", () => {
  const site = new URL(process.env.BETTER_AUTH_URL!);
  const offer = whatsAppProductInquiry("bd", "Fixture case", new URL("/products/fixture-case?session=private#hidden", site).href);
  const link = new URL(offer!);
  assert.equal(link.origin, "https://wa.me");
  assert.equal(link.pathname, "/12025550101");
  assert.equal(link.searchParams.get("text"), `Hello, I have a question about Fixture case. ${site.origin}/products/fixture-case?market=bd`);
  assert.equal(whatsAppProductInquiry("bd", "Fixture", "https://foreign.example.invalid/products/fixture"), undefined);
  assert.equal(whatsAppOrderInquiry("us", "M11-test"), undefined);
  assert.equal(whatsAppOrderInquiry("bd", "M11-test@private"), undefined);
  assert.equal(new URL(whatsAppOrderInquiry("bd", "M11-test")!).searchParams.get("text"), "Hello, I have a question about order M11-test.");
});
