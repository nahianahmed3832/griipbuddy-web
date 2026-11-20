import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import "../../scripts/load-env.ts";
import { markets, type MarketId } from "../../src/config/markets.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { recordCodRemittance } from "../../src/lib/staff/cod-remittance.ts";
import {
  SellerFinanceError, sellerFinanceAction, sellerFinanceStatement, staffSellerFinance,
  staffSellerFinanceAction,
} from "../../src/lib/marketplace/seller-finance.ts";

requireLocalDatabase("griipbuddy_test");
process.env.GRIIP_SELLER_FINANCE_TEST = "1";
const db = getDb();
const fixture = randomUUID();
const [sellerA, sellerB, delegate] = ["seller-a", "seller-b", "finance-view"].map(name => `${name}-${fixture}`);
const [shopA, shopB] = [randomUUID(), randomUUID()];
const orders: string[] = [];
const attempts: string[] = [];
const policyIds: string[] = [];
let owner: string;
let variants: string[];

before(async () => {
  const staff = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true }, select: { userId: true } });
  owner = staff.userId;
  variants = (await db.variant.findMany({ select: { id: true }, take: 2 })).map(result => result.id);
  assert.equal(variants.length, 2, "Seed the fixture catalog before testing settlement.");
  await db.shopper.createMany({ data: [sellerA, sellerB, delegate].map(id => ({ id,
    email: `${id}@example.invalid`, name: "Synthetic finance actor" })) });
  await db.marketplaceShop.createMany({ data: [[shopA, sellerA], [shopB, sellerB]].map(([id, ownerId], i) => ({
    id, ownerId, slug: `m08-finance-${i}-${fixture}`, name: `Finance fixture ${i}`, about: "", announcement: "", published: true,
  })) });
  await db.marketplaceShopMarket.createMany({ data: [shopA, shopB].flatMap(shopId => (["bd", "us"] as const).map(marketId =>
    ({ shopId, marketId, status: "APPROVED" }))) });
  await db.marketplaceSellerMember.create({ data: { shopId: shopA, shopperId: delegate, marketId: "bd",
    acceptedAt: new Date(), permissions: ["FINANCE_VIEW"] } });
});

after(async () => {
  const scope = { shopId: { in: [shopA, shopB] } };
  await db.sellerFinanceAudit.deleteMany({ where: { OR: [scope, { recordId: { in: [...orders, ...policyIds] } }] } });
  await db.sellerFinancePayout.deleteMany({ where: scope });
  await db.sellerFinanceDestination.deleteMany({ where: scope });
  await db.sellerFinanceEntry.deleteMany({ where: scope });
  await db.sellerFinanceFunding.deleteMany({ where: { orderId: { in: orders } } });
  await db.sellerFinancePolicy.deleteMany({ where: { id: { in: policyIds } } });
  await db.orderCase.deleteMany({ where: { orderId: { in: orders } } });
  await db.codRemittance.deleteMany({ where: { orderId: { in: orders } } });
  await db.payment.deleteMany({ where: { orderId: { in: orders } } });
  await db.orderItem.deleteMany({ where: { orderId: { in: orders } } });
  await db.order.deleteMany({ where: { id: { in: orders } } });
  await db.providerPaymentEvent.deleteMany({ where: { attemptId: { in: attempts } } });
  await db.checkoutAttempt.deleteMany({ where: { id: { in: attempts } } });
  await db.marketplaceShop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await db.shopper.deleteMany({ where: { id: { in: [sellerA, sellerB, delegate] } } });
  await db.$disconnect();
});

const support = { reason: "Verified synthetic fixture evidence" };
const decision = (payoutId: string, choice: "APPROVE" | "REJECT") => ({
  kind: "payout-review", payoutId, decision: choice, ...support,
});
const processOutcome = (payoutId: string, outcome: "CONFIRMED" | "FAILED" | "TIMEOUT") => ({
  kind: "payout-process", payoutId, outcome, ...support,
});
const expectStatus = (status: number) => (error: unknown) => error instanceof SellerFinanceError && error.status === status;

async function policy(market: MarketId, commissionBps: number, processingFeeBps: number, holdDays: number) {
  const operationId = randomUUID();
  policyIds.push(operationId);
  const input = { kind: "policy-create", operationId, commissionBps, processingFeeBps, holdDays };
  const saved = await staffSellerFinanceAction(owner, market, input);
  assert.deepEqual(await staffSellerFinanceAction(owner, market, input), saved);
  return saved;
}

async function fixtureOrder(market: MarketId, kind: "COD" | "PAYPAL", synthetic = true) {
  const attemptId = randomUUID();
  attempts.push(attemptId);
  const currency = markets[market].currency;
  const accountKey = randomBytes(32).toString("hex");
  const captureId = `test-capture-${attemptId}`;
  await db.checkoutAttempt.create({ data: { id: attemptId, guestKey: randomBytes(32).toString("hex"),
    requestHash: randomBytes(32).toString("hex"), marketId: market, paymentMethod: kind, commerceEvidence: "fixture",
    ...(kind === "PAYPAL" && { paypal: { create: { state: "COMPLETED", providerAccountKey: accountKey,
      expectedAmountMinor: 5025, captureId, expiresAt: new Date(Date.now() + 300_000) } } }),
  } });
  if (kind === "PAYPAL") await db.providerPaymentEvent.create({ data: { provider: kind, accountKey, attemptId, marketId: market,
    providerReference: captureId, eventKey: `capture:${attemptId}`, eventType: "CAPTURE_VERIFIED", currency, amountMinor: 5025,
    outcome: "PAID", processedAt: new Date(), evidenceHash: randomBytes(32).toString("hex") } });
  const order = await db.order.create({ data: {
    reference: `FINANCE-${randomUUID()}`, attemptId, marketId: market, currency,
    measurementTest: synthetic, commerceEvidence: synthetic ? "fixture" : "production", fulfillmentStatus: "DELIVERED",
    customerName: "SYNTHETIC-CUSTOMER-PRIVATE", phone: "0000000000", district: "synthetic",
    districtLabel: "Fixture", locality: "Fixture", address: "SYNTHETIC-ADDRESS-PRIVATE", deliveryMethod: "standard", deliveryLabel: "Synthetic",
    taxLabel: "Fixture tax", subtotalMinor: 5000, discountMinor: 500, deliveryMinor: 300, taxMinor: 225, totalMinor: 5025,
    payment: { create: { method: kind, status: kind === "COD" ? "AWAITING_COLLECTION" : "PAID", amountMinor: 5025, currency } },
    items: { create: [
      { variantId: variants[0], marketplaceShopId: shopA, productName: "Synthetic A", sku: "FA", variantName: "A", quantity: 2,
        unitPriceMinor: 2000, unitDiscountMinor: 250, lineTotalMinor: 3500, currency, taxAllocatedMinor: 175, deliveryAllocatedMinor: 200 },
      { variantId: variants[1], marketplaceShopId: shopB, productName: "Synthetic B", sku: "FB", variantName: "B", quantity: 1,
        unitPriceMinor: 1000, unitDiscountMinor: 0, lineTotalMinor: 1000, currency, taxAllocatedMinor: 50, deliveryAllocatedMinor: 100 },
    ] },
  }, include: { items: true } });
  orders.push(order.id);
  return { ...order, accountKey };
}

async function verifiedDestination(market: MarketId) {
  const operationId = randomUUID();
  const destination = { kind: "destination-submit", operationId, label: "Synthetic payout route", testReference: "TEST-DEMO1234" };
  await assert.rejects(sellerFinanceAction(delegate, shopA, market, destination), expectStatus(403));
  const submitted = await sellerFinanceAction(sellerA, shopA, market, destination);
  assert.deepEqual(submitted, { id: operationId, state: "PENDING" });
  assert.deepEqual(await sellerFinanceAction(sellerA, shopA, market, destination), submitted);
  await assert.rejects(sellerFinanceAction(sellerA, shopA, market, { ...destination, label: "Changed evidence" }), expectStatus(409));
  const verification = { kind: "destination-review", destinationId: operationId, decision: "VERIFY", ...support };
  await assert.rejects(staffSellerFinanceAction(owner, market === "bd" ? "us" : "bd", verification), expectStatus(404));
  assert.deepEqual(await staffSellerFinanceAction(owner, market, verification), { id: operationId, state: "VERIFIED" });
  const safe = await sellerFinanceStatement(sellerA, shopA, market);
  assert.equal(safe.destinations.find(row => row.id === operationId)?.maskedReference, "TEST-••••1234");
  assert.ok(!JSON.stringify(safe).includes(destination.testReference));
  return operationId;
}

test("BD COD requires delivery, collection, matched remittance and policy hold before claiming payout funds", async () => {
  await policy("bd", 300, 0, 1);
  const order = await fixtureOrder("bd", "COD");
  const command = { kind: "reconcile-order", orderId: order.id };
  const pending = await staffSellerFinanceAction(owner, "bd", command);
  assert.equal("state" in pending && pending.state, "AWAITING_PAYMENT");
  assert.equal((await sellerFinanceStatement(sellerA, shopA, "bd")).entries.length, 0);
  await db.payment.update({ where: { orderId: order.id }, data: { status: "COLLECTED", collectedAt: new Date() } });
  const collected = await staffSellerFinanceAction(owner, "bd", command);
  assert.equal("state" in collected && collected.state, "AWAITING_FUNDS");
  const view = await sellerFinanceStatement(delegate, shopA, "bd");
  assert.deepEqual([view.totals.pendingMinor, view.totals.availableMinor], [3595, 0]);
  await assert.rejects(sellerFinanceStatement(delegate, shopB, "bd"), expectStatus(404));
  await assert.rejects(sellerFinanceStatement(delegate, shopA, "us"), expectStatus(404));
  await assert.rejects(staffSellerFinance(delegate, "bd"), expectStatus(403));
  await assert.rejects(staffSellerFinanceAction(owner, "us", command), expectStatus(404));
  const destination = await verifiedDestination("bd");
  const capped = (operationId = randomUUID()) => ({
    kind: "payout-request", operationId, destinationId: destination, amountMinor: 3000,
  });
  await assert.rejects(sellerFinanceAction(delegate, shopA, "bd", capped()), expectStatus(403));
  await assert.rejects(sellerFinanceAction(sellerA, shopA, "bd", capped()), expectStatus(409));
  assert.equal(await recordCodRemittance(owner, order.id, { reference: "TEST-M08-DISCREPANCY", grossMinor: 5025, deductionsMinor: 125, netMinor: 4899 }), "DISCREPANCY");
  const mismatched = await staffSellerFinanceAction(owner, "bd", command);
  assert.equal("state" in mismatched && mismatched.state, "AWAITING_FUNDS");
  assert.equal(await recordCodRemittance(owner, order.id, { reference: "TEST-M08-MATCHED", grossMinor: 5025, deductionsMinor: 125, netMinor: 4900 }), "MATCHED");
  const held = await staffSellerFinanceAction(owner, "bd", command);
  assert.equal("state" in held && held.state, "HELD");
  const heldView = await sellerFinanceStatement(sellerA, shopA, "bd");
  assert.deepEqual([heldView.totals.pendingMinor, heldView.totals.heldMinor, heldView.totals.availableMinor, heldView.totals.feeMinor], [0, 3499, 0, 96]);
  await assert.rejects(sellerFinanceAction(sellerA, shopA, "bd", capped()), expectStatus(409));
  // Advance the synthetic source clock after demonstrating the production hold checks.
  await db.codRemittance.updateMany({ where: { orderId: order.id, status: "MATCHED" },
    data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
  await Promise.all([staffSellerFinanceAction(owner, "bd", command), staffSellerFinanceAction(owner, "bd", command)]);
  const available = await sellerFinanceStatement(sellerA, shopA, "bd");
  assert.equal(available.totals.availableMinor, 3499);
  assert.deepEqual(available.entries.map(row => row.kind).sort(), ["ACCRUAL", "HOLD", "RELEASE"]);
  await assert.rejects(sellerFinanceAction(sellerA, shopB, "bd", capped()), expectStatus(403));
  const candidates = [capped(), capped()];
  const requested = await Promise.allSettled(candidates.map(input => sellerFinanceAction(sellerA, shopA, "bd", input)));
  assert.equal(requested.filter(result => result.status === "fulfilled").length, 1);
  const accepted = candidates[requested.findIndex(result => result.status === "fulfilled")];
  assert.deepEqual(await sellerFinanceAction(sellerA, shopA, "bd", accepted), { id: accepted.operationId, state: "REQUESTED" });
  assert.equal((await sellerFinanceStatement(sellerA, shopA, "bd")).totals.availableMinor, 499);
  await staffSellerFinanceAction(owner, "bd", decision(accepted.operationId, "REJECT"));
  assert.equal((await sellerFinanceStatement(sellerA, shopA, "bd")).totals.availableMinor, 3499);
  const failed = capped();
  await sellerFinanceAction(sellerA, shopA, "bd", failed);
  await staffSellerFinanceAction(owner, "bd", decision(failed.operationId, "APPROVE"));
  assert.equal((await sellerFinanceStatement(sellerA, shopA, "bd")).totals.paidMinor, 0);
  await staffSellerFinanceAction(owner, "bd", processOutcome(failed.operationId, "FAILED"));
  assert.equal((await sellerFinanceStatement(sellerA, shopA, "bd")).totals.availableMinor, 3499);
});

test("US capture, policy version, timeout reconciliation and exact seller refund after payout", async () => {
  await policy("us", 500, 100, 0);
  const order = await fixtureOrder("us", "PAYPAL");
  const reconcile = { kind: "reconcile-order", orderId: order.id };
  await Promise.all([staffSellerFinanceAction(owner, "us", reconcile), staffSellerFinanceAction(owner, "us", reconcile)]);
  const preFunding = await sellerFinanceStatement(sellerA, shopA, "us");
  assert.deepEqual([preFunding.totals.grossMinor, preFunding.totals.discountMinor, preFunding.totals.pendingMinor,
    preFunding.totals.commissionMinor, preFunding.totals.feeMinor, preFunding.totals.availableMinor], [4000, 500, 3486, 175, 39, 0]);
  await policy("us", 2300, 0, 0);
  const release = { kind: "online-release", orderId: order.id, operationId: randomUUID(), testReference: "TEST-FUNDING127", ...support };
  await Promise.all([staffSellerFinanceAction(owner, "us", release), staffSellerFinanceAction(owner, "us", release)]);
  assert.equal((await sellerFinanceStatement(sellerA, shopA, "us")).entries.every(row => row.policyVersion === 1), true);
  const destinationId = await verifiedDestination("us");
  const payoutId = randomUUID();
  await sellerFinanceAction(sellerA, shopA, "us", { kind: "payout-request", operationId: payoutId, destinationId, amountMinor: 3486 });
  await staffSellerFinanceAction(owner, "us", decision(payoutId, "APPROVE"));
  const timed = processOutcome(payoutId, "TIMEOUT");
  assert.deepEqual(await staffSellerFinanceAction(owner, "us", timed), { id: payoutId, state: "RECONCILIATION" });
  assert.deepEqual(await staffSellerFinanceAction(owner, "us", timed), { id: payoutId, state: "RECONCILIATION" });
  const unresolved = await staffSellerFinance(owner, "us", shopA);
  assert.deepEqual([unresolved.totals.availableMinor, unresolved.totals.reservedMinor, unresolved.totals.paidMinor], [0, 3486, 0]);
  const attemptReference = unresolved.payouts.find(row => row.id === payoutId)?.attemptReference;
  assert.equal(attemptReference, `TEST-PAYOUT-${payoutId}`);
  await assert.rejects(staffSellerFinanceAction(owner, "us", processOutcome(payoutId, "CONFIRMED")), expectStatus(409));
  const confirmation = { kind: "payout-reconcile", payoutId, outcome: "CONFIRMED", attemptReference, ...support };
  await assert.rejects(staffSellerFinanceAction(owner, "us", { ...confirmation, attemptReference: `TEST-PAYOUT-${randomUUID()}` }), expectStatus(409));
  await Promise.all([staffSellerFinanceAction(owner, "us", confirmation), staffSellerFinanceAction(owner, "us", confirmation)]);
  const ownLine = order.items.find(line => line.marketplaceShopId === shopA)!;
  const caseId = randomUUID();
  const providerRefundId = `test-refund-${caseId}`;
  const refundAmount = 1837;
  await db.orderCase.create({ data: { id: caseId, orderId: order.id, kind: "RETURN", status: "REFUND_APPROVED",
    returnReceivedAt: new Date(), returnReceivedById: owner, returnDisposition: "HOLD", refundAmountMinor: refundAmount,
    returnLines: { create: { orderItemId: ownLine.id, quantity: 1, settlementUnitOffset: 0 } },
    refund: { create: { method: "PAYPAL", currency: "USD", amountMinor: refundAmount, state: "CONFIRMED",
      providerRefundId, confirmedAt: new Date() } },
  } });
  await db.providerPaymentEvent.create({ data: { provider: "PAYPAL", accountKey: order.accountKey, attemptId: order.attemptId, marketId: "us",
    providerReference: providerRefundId, eventKey: `refund:${caseId}`, eventType: "CASE_REFUND_CONFIRMED", currency: "USD", amountMinor: refundAmount,
    outcome: "PROCESSED", processedAt: new Date(), evidenceHash: randomBytes(32).toString("hex") } });
  const anotherPayout = { kind: "payout-request", operationId: randomUUID(), destinationId, amountMinor: 1 };
  await assert.rejects(sellerFinanceAction(sellerA, shopA, "us", anotherPayout), /refund evidence/);
  await Promise.all([staffSellerFinanceAction(owner, "us", reconcile), staffSellerFinanceAction(owner, "us", reconcile)]);
  const [viewA, viewB] = await Promise.all([sellerFinanceStatement(sellerA, shopA, "us"), sellerFinanceStatement(sellerB, shopB, "us")]);
  assert.deepEqual([viewA.totals.refundedMinor, viewA.totals.availableMinor, viewA.totals.paidMinor], [1837, -1663, 3486]);
  assert.deepEqual([viewB.totals.refundedMinor, viewB.totals.availableMinor, viewB.totals.paidMinor], [0, 1039, 0]);
  assert.equal(viewA.entries.filter(row => row.kind === "REFUND").length, 1);
  assert.deepEqual(viewA.audit, []);
  const authorizedAudit = (await staffSellerFinance(owner, "us", shopA)).audit;
  assert.equal(authorizedAudit.filter(row => row.action === "ENTRY_REFUND" && row.recordId === order.id).length, 1);
  assert.equal(viewA.payouts.find(row => row.id === payoutId)?.attemptReference, null);
  assert.ok(!JSON.stringify(viewA).includes("SYNTHETIC-CUSTOMER-PRIVATE"));
  assert.equal((await db.sellerFinanceAudit.count({ where: { recordId: payoutId, action: "PAYOUT_COMPLETED" } })), 1);
  const outside = await sellerFinanceStatement(sellerA, shopA, "us", {
    start: new Date("2000-01-01T00:00:00Z"), endExclusive: new Date("2000-01-02T00:00:00Z"),
  });
  assert.equal(outside.entries.length, 0);
  assert.equal(outside.totals.availableMinor, -1663);
  await assert.rejects(sellerFinanceAction(sellerA, shopA, "us", anotherPayout), /available funds/);
  await db.marketplaceShopMarket.update({ where: { shopId_marketId: { shopId: shopA, marketId: "us" } }, data: { status: "DENIED" } });
  await assert.rejects(sellerFinanceStatement(sellerA, shopA, "us"), expectStatus(404));
});

test("operational activation and live-classified orders are refused", async () => {
  const live = await fixtureOrder("bd", "COD", false);
  await assert.rejects(staffSellerFinanceAction(owner, "bd", { kind: "reconcile-order", orderId: live.id }), expectStatus(404));
  process.env.GRIIP_SELLER_FINANCE_TEST = "0";
  try {
    await assert.rejects(staffSellerFinance(owner, "bd"), expectStatus(403));
    await assert.rejects(sellerFinanceStatement(sellerA, shopA, "bd"), expectStatus(403));
  } finally {
    process.env.GRIIP_SELLER_FINANCE_TEST = "1";
  }
});
