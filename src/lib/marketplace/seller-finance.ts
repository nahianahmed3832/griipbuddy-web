import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { isMarketId, type MarketId } from "../../config/markets.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { getDb } from "../db/client.ts";
import { localDatabase } from "../db/local.ts";
import { activeSellerMarket, getSellerAccess, lockSellerScope } from "./seller-access.ts";
import { SellerFinanceError, financeAssert } from "./seller-finance-money.ts";
import { financeLock, financeScope, loadSettlementOrder, postOrderSettlement, settlementOrderLock, settlementPayment,
  type FinanceDb } from "./seller-finance-ledger.ts";

export { SellerFinanceError };

export function sellerFinanceTestEnabled() {
  return process.env.GRIIP_SELLER_FINANCE_TEST === "1" && localDatabase() === "griipbuddy_test";
}
function checkEnvironment(marketId: MarketId) {
  financeAssert(sellerFinanceTestEnabled(), "Seller finance is unavailable outside the isolated synthetic workspace.", 403);
  financeAssert(isMarketId(marketId), "Choose an operating market.", 400);
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const positiveAmount = z.number().int().min(1).max(2_147_483_647);
const bps = z.number().int().min(0).max(10_000);
const reason = z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001F\u007F]+$/u);
const testRef = z.string().trim().regex(/^TEST-[A-Za-z0-9_-]{4,48}$/);
const confirmation = z.enum(["CONFIRMED", "FAILED"]);
const attemptReference = z.string().regex(/^TEST-PAYOUT-[0-9a-f-]{36}$/);
const sellerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("destination-submit"), operationId: uuid, label: z.string().trim().min(1).max(60)
    .regex(/^[^\u0000-\u001F\u007F]+$/u), testReference: testRef }).strict(),
  z.object({ kind: z.literal("destination-revoke"), destinationId: uuid }).strict(),
  z.object({ kind: z.literal("payout-request"), operationId: uuid, destinationId: uuid, amountMinor: positiveAmount }).strict(),
]);
const staffInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("policy-create"), operationId: uuid, commissionBps: bps, processingFeeBps: bps,
    holdDays: z.number().int().min(0).max(180), effectiveAt: z.iso.datetime({ offset: true }).optional() }).strict(),
  z.object({ kind: z.literal("reconcile-order"), orderId: uuid }).strict(),
  z.object({ kind: z.literal("online-release"), orderId: uuid, operationId: uuid, testReference: testRef, reason }).strict(),
  z.object({ kind: z.literal("destination-review"), destinationId: uuid, decision: z.enum(["VERIFY", "REVOKE"]), reason }).strict(),
  z.object({ kind: z.literal("payout-review"), payoutId: uuid, decision: z.enum(["APPROVE", "REJECT"]), reason }).strict(),
  z.object({ kind: z.literal("payout-process"), payoutId: uuid, outcome: z.enum(["CONFIRMED", "FAILED", "TIMEOUT"]),
    attemptReference: attemptReference.optional(), reason }).strict(),
  z.object({ kind: z.literal("payout-reconcile"), payoutId: uuid, outcome: confirmation, attemptReference, reason }).strict(),
]);
type StaffCommand = z.infer<typeof staffInput>;
type PayoutOutcome = Extract<StaffCommand, { kind: "payout-process" | "payout-reconcile" }>;
type Scope = ReturnType<typeof financeScope> & { shopId?: string };
type Actor = { actorId: string; actorKind: "staff" | "shopper" };
type Period = { start: Date; endExclusive: Date };

const destinationSelect = { id: true, shopId: true, label: true, maskedReference: true, state: true } as const;
const policySelect = { id: true, version: true, commissionBps: true, processingFeeBps: true, holdDays: true, effectiveAt: true } as const;
const payoutSelect = { id: true, shopId: true, destinationId: true, amountMinor: true, status: true,
  createdAt: true, updatedAt: true, reason: true, attemptReference: true } as const;
const reservedStates = ["REQUESTED", "APPROVED", "PROCESSING", "RECONCILIATION"] as const;

async function checkStaff(db: FinanceDb, actorId: string, write = false) {
  if (write) await db.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actorId} FOR SHARE`;
  const staff = await db.staffAccess.findUnique({ where: { userId: actorId }, select: { role: true, active: true } });
  financeAssert(staff?.active && staff.role === "OWNER", "This workspace requires finance owner access.", 403);
}

async function audit(db: FinanceDb, scope: Scope, actor: Actor, recordId: string, action: string, details?: Prisma.InputJsonObject) {
  await db.sellerFinanceAudit.create({ data: { ...scope, ...actor, recordId, action, details } });
}

async function balances(db: FinanceDb, scope: Scope) {
  const [entries, payouts] = await Promise.all([
    db.sellerFinanceEntry.aggregate({ where: scope, _sum: { pendingDelta: true, heldDelta: true, availableDelta: true } }),
    db.sellerFinancePayout.groupBy({ by: ["status"], where: scope, _sum: { amountMinor: true } }),
  ]);
  const reservedMinor = payouts.reduce((amount, row) =>
    reservedStates.some(status => status === row.status) ? amount + (row._sum.amountMinor ?? 0) : amount, 0);
  const paidMinor = payouts.find(row => row.status === "COMPLETED")?._sum.amountMinor ?? 0;
  return { pendingMinor: entries._sum.pendingDelta ?? 0, heldMinor: entries._sum.heldDelta ?? 0,
    availableMinor: (entries._sum.availableDelta ?? 0) - reservedMinor - paidMinor, reservedMinor, paidMinor };
}

async function statement(db: FinanceDb, scope: Scope, staff: boolean, period?: Period) {
  const { shopId, marketId, currency } = scope;
  if (period) financeAssert(Number.isFinite(period.start.getTime()) && Number.isFinite(period.endExclusive.getTime()) &&
    period.endExclusive > period.start, "Choose a valid statement period.", 400);
  const date = period && { gte: period.start, lt: period.endExclusive };
  const [policy, totals, rows, destinations, payoutRows, shops, history] = await Promise.all([
    db.sellerFinancePolicy.findFirst({ where: { marketId, currency, effectiveAt: { lte: new Date() } },
      orderBy: { version: "desc" }, select: policySelect }),
    balances(db, scope),
    db.sellerFinanceEntry.findMany({ where: { ...scope, ...(date && { sourceAt: date }) }, take: 5001,
      orderBy: [{ sourceAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], select: {
        id: true, shopId: true, kind: true, createdAt: true, sourceAt: true, orderId: true, sourceId: true,
        grossMinor: true, discountMinor: true, taxMinor: true, shippingMinor: true, commissionMinor: true, feeMinor: true,
        netMinor: true, refundMinor: true, order: { select: { reference: true } }, policy: { select: { version: true } },
      } }),
    db.sellerFinanceDestination.findMany({ where: scope, select: destinationSelect, orderBy: { createdAt: "desc" }, take: 501 }),
    db.sellerFinancePayout.findMany({ where: scope, select: payoutSelect, orderBy: { createdAt: "desc" }, take: 501 }),
    db.marketplaceShop.findMany({ where: shopId ? { id: shopId } : {
      OR: [activeSellerMarket(marketId), { financeEntries: { some: { marketId, currency } } }],
    }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 }),
    staff ? db.sellerFinanceAudit.findMany({ where: scope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100,
      select: { id: true, shopId: true, action: true, recordId: true, actorKind: true, details: true, createdAt: true } }) : [],
  ]);
  financeAssert(rows.length <= 5000, "Too many entries for this statement. Choose a shorter period.");
  financeAssert(destinations.length <= 500 && payoutRows.length <= 500 && shops.length <= 500, "Choose a single seller to review this workspace.");
  const activity = { grossMinor: 0, discountMinor: 0, taxMinor: 0, shippingMinor: 0, commissionMinor: 0, feeMinor: 0,
    netEarningsMinor: 0, refundedMinor: 0 };
  const entries = rows.map(({ order, policy, ...row }) => {
    activity.grossMinor += row.grossMinor;
    activity.discountMinor += row.discountMinor;
    activity.taxMinor += row.taxMinor;
    activity.shippingMinor += row.shippingMinor;
    activity.commissionMinor += row.commissionMinor;
    activity.feeMinor += row.feeMinor;
    activity.netEarningsMinor += row.netMinor;
    activity.refundedMinor += row.refundMinor;
    return { ...row, orderReference: order.reference, policyVersion: policy.version };
  });
  const payouts = payoutRows.map(row => staff ? row : { ...row, attemptReference: null, reason: null });
  const audit = history.map(({ details, ...row }) => ({ ...row,
    reason: details && typeof details === "object" && !Array.isArray(details) && typeof details.reason === "string" ? details.reason : null,
  }));
  return { marketId, currency, policy, shops, totals: { ...activity, ...totals }, entries, destinations, payouts, audit };
}
export type FinanceStatement = Awaited<ReturnType<typeof statement>>;

export async function sellerFinanceStatement(shopperId: string, shopId: string, marketId: MarketId, period?: Period) {
  checkEnvironment(marketId);
  return getDb().$transaction(async db => {
    financeAssert(await getSellerAccess(shopperId, shopId, marketId, "FINANCE_VIEW", db),
      "This seller statement is unavailable in this market.", 404);
    return statement(db, { ...financeScope(marketId), shopId }, false, period);
  }, { isolationLevel: "RepeatableRead" });
}

export async function staffSellerFinance(actorId: string, marketId: MarketId, shopId?: string, period?: Period) {
  checkEnvironment(marketId);
  financeAssert(!shopId || uuid.safeParse(shopId).success, "Choose a valid seller.", 400);
  return getDb().$transaction(async db => {
    await checkStaff(db, actorId);
    return statement(db, { ...financeScope(marketId), shopId }, true, period);
  }, { isolationLevel: "RepeatableRead" });
}

async function ensureCurrentRefunds(db: FinanceDb, scope: Scope & { shopId: string }) {
  const unknown = await db.$queryRaw<{ pending: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "SellerFinanceEntry" accrual
      JOIN "Order" o ON o.id = accrual."orderId"
      JOIN "Payment" p ON p."orderId" = o.id
      LEFT JOIN "PayPalCheckout" paypal ON paypal."attemptId" = o."attemptId"
      WHERE accrual."shopId" = ${scope.shopId}::uuid AND accrual."marketId" = ${scope.marketId}::"MarketCode"
        AND accrual.currency = ${scope.currency}::"CurrencyCode" AND accrual.kind = 'ACCRUAL'
        AND (
          p.status = 'REFUND_PENDING'
          OR (
            p.status = 'REFUNDED' AND paypal."refundActorId" IS NOT NULL AND paypal."refundStartedAt" IS NOT NULL AND
            NOT EXISTS (SELECT 1 FROM "SellerFinanceEntry" posted WHERE posted."shopId" = accrual."shopId"
              AND posted."orderId" = o.id AND posted.kind = 'REFUND' AND posted."sourceId" = 'whole-order:' || o.id::text)
          )
          OR EXISTS (
            SELECT 1 FROM "OrderCase" c JOIN "OrderCaseRefund" r ON r."caseId" = c.id
            WHERE c."orderId" = o.id AND r.state IN ('AUTHORIZED', 'PROCESSING', 'CONFIRMED', 'FAILED')
              AND (
                NOT EXISTS (SELECT 1 FROM "OrderCaseReturnLine" line WHERE line."caseId" = c.id)
                OR EXISTS (
                  SELECT 1 FROM "OrderCaseReturnLine" line JOIN "OrderItem" i ON i.id = line."orderItemId"
                  WHERE line."caseId" = c.id AND i."marketplaceShopId" = accrual."shopId"
                )
              )
              AND NOT EXISTS (SELECT 1 FROM "SellerFinanceEntry" posted WHERE posted."shopId" = accrual."shopId"
                AND posted."orderId" = o.id AND posted.kind = 'REFUND' AND posted."sourceId" = c.id::text)
          )
        )
    ) AS pending`;
  financeAssert(!unknown[0]?.pending, "Reconcile the seller’s original-payment refund evidence before requesting payout.");
}

export async function sellerFinanceAction(shopperId: string, shopId: string, marketId: MarketId, raw: unknown) {
  checkEnvironment(marketId);
  financeAssert(uuid.safeParse(shopId).success, "This seller finance workspace is unavailable.", 404);
  const result = sellerInput.safeParse(raw);
  financeAssert(result.success, "Enter valid synthetic evidence and operation details.", 400);
  const command = result.data;
  const scope = { ...financeScope(marketId), shopId };
  const actor: Actor = { actorId: shopperId, actorKind: "shopper" };

  return getDb().$transaction(async db => {
    await lockSellerScope(db, shopId, marketId);
    financeAssert(await getSellerAccess(shopperId, shopId, marketId,
      command.kind === "payout-request" ? "PAYOUT_REQUEST" : "PAYOUT_DESTINATION", db),
    "Your seller role does not allow this action in this market.", 403);
    await financeLock(db, marketId, shopId);
    if (command.kind === "destination-submit") {
      const hash = fingerprint({ scope, label: command.label, reference: command.testReference });
      const previous = await db.sellerFinanceDestination.findUnique({ where: { id: command.operationId } });
      if (previous) {
        financeAssert(previous.fingerprint === hash, "This destination operation already exists with different details.");
        return { id: previous.id, state: previous.state };
      }
      const destination = await db.sellerFinanceDestination.create({ data: { ...scope, id: command.operationId,
        label: command.label, fingerprint: hash, referenceHash: fingerprint(command.testReference),
        maskedReference: `TEST-••••${command.testReference.slice(-4)}`,
      }, select: destinationSelect });
      await audit(db, scope, actor, destination.id, "DESTINATION_SUBMITTED");
      return { id: destination.id, state: destination.state };
    }
    if (command.kind === "destination-revoke") {
      const destination = await db.sellerFinanceDestination.findFirst({ where: { ...scope, id: command.destinationId } });
      financeAssert(destination, "Destination unavailable.", 404);
      if (destination.state !== "REVOKED") {
        await db.sellerFinanceDestination.update({ where: { id: destination.id }, data: { state: "REVOKED" } });
        await audit(db, scope, actor, destination.id, "DESTINATION_REVOKED");
      }
      return { id: destination.id, state: "REVOKED" };
    }
    const hash = fingerprint({ scope, destinationId: command.destinationId, amountMinor: command.amountMinor });
    const previous = await db.sellerFinancePayout.findUnique({ where: { id: command.operationId } });
    if (previous) {
      financeAssert(previous.fingerprint === hash, "This payout operation already exists with different details.");
      return { id: previous.id, state: previous.status };
    }
    const destination = await db.sellerFinanceDestination.findFirst({ where: { ...scope, id: command.destinationId, state: "VERIFIED" } });
    financeAssert(destination, "Choose a currently verified synthetic payout destination.");
    await ensureCurrentRefunds(db, scope);
    const { availableMinor } = await balances(db, scope);
    financeAssert(availableMinor >= command.amountMinor, "The requested amount exceeds available funds.");
    const payout = await db.sellerFinancePayout.create({ data: { ...scope, id: command.operationId, destinationId: destination.id,
      amountMinor: command.amountMinor, fingerprint: hash, destinationHash: destination.referenceHash }, select: payoutSelect });
    await audit(db, scope, actor, payout.id, "PAYOUT_RESERVED", { amountMinor: payout.amountMinor, destinationId: payout.destinationId });
    return { id: payout.id, state: payout.status };
  });
}

async function savePolicy(db: FinanceDb, marketId: MarketId, actor: Actor, input: Extract<StaffCommand, { kind: "policy-create" }>) {
  const scope = financeScope(marketId);
  await financeLock(db, marketId, "policy");
  const hash = fingerprint({ scope, input });
  const previous = await db.sellerFinancePolicy.findUnique({ where: { id: input.operationId } });
  if (previous) {
    financeAssert(previous.fingerprint === hash, "This policy operation already exists with different details.");
    return { id: previous.id, version: previous.version };
  }
  const latest = await db.sellerFinancePolicy.findFirst({ where: scope, orderBy: { version: "desc" } });
  const now = new Date();
  const effectiveAt = input.effectiveAt ? new Date(input.effectiveAt) : now;
  financeAssert(input.commissionBps + input.processingFeeBps <= 10_000, "Commission and fee cannot exceed the source amount.", 422);
  financeAssert(effectiveAt >= now && (!latest || effectiveAt > latest.effectiveAt), "Use an effective time after the previous policy.");
  const { operationId: id, commissionBps, processingFeeBps, holdDays } = input;
  const version = (latest?.version ?? 0) + 1;
  await db.sellerFinancePolicy.create({ data: { ...scope, id, version, commissionBps, processingFeeBps,
    holdDays, effectiveAt, actorId: actor.actorId, fingerprint: hash } });
  await audit(db, scope, actor, id, "POLICY_PUBLISHED", { version, commissionBps, processingFeeBps, holdDays, effectiveAt: effectiveAt.toISOString() });
  return { id, version };
}

async function lockPayout(db: FinanceDb, scope: Scope, id: string) {
  const where = { ...scope, id };
  const match = await db.sellerFinancePayout.findFirst({ where, select: { shopId: true } });
  financeAssert(match, "Payout unavailable in this market.", 404);
  await lockSellerScope(db, match.shopId, scope.marketId);
  await financeLock(db, scope.marketId, match.shopId);
  return db.sellerFinancePayout.findFirstOrThrow({ where, include: { destination: true } });
}

async function recordPayoutOutcome(db: FinanceDb, scope: Scope, actor: Actor, command: PayoutOutcome) {
  const payout = await lockPayout(db, scope, command.payoutId);
  const outcome = command.outcome === "CONFIRMED" ? "COMPLETED" : command.outcome === "FAILED" ? "FAILED" : "RECONCILIATION";
  const provided = command.attemptReference ?? `TEST-PAYOUT-${payout.id}`;
  financeAssert(provided === payout.attemptReference && payout.destination.referenceHash === payout.destinationHash,
    "The result must match the original synthetic payout attempt and destination.");
  if (payout.status === outcome) return { id: payout.id, state: payout.status };
  financeAssert(payout.status === (command.kind === "payout-reconcile" ? "RECONCILIATION" : "PROCESSING"),
    "The attempt requires reconciliation with its existing reference.");
  await db.sellerFinancePayout.update({ where: { id: payout.id }, data: { status: outcome, reason: command.reason } });
  await audit(db, { ...scope, shopId: payout.shopId }, actor, payout.id, `PAYOUT_${outcome}`, { reason: command.reason,
    amountMinor: payout.amountMinor, destinationId: payout.destinationId, attemptReference: provided });
  return { id: payout.id, state: outcome };
}

async function startPayout(db: FinanceDb, scope: Scope, actor: Actor,
  command: Extract<StaffCommand, { kind: "payout-process" }>) {
  const payout = await lockPayout(db, scope, command.payoutId);
  const reference = `TEST-PAYOUT-${payout.id}`;
  financeAssert(!command.attemptReference || command.attemptReference === reference, "Use the existing synthetic attempt reference.");
  if (payout.attemptReference) return;
  financeAssert(payout.status === "APPROVED" && payout.destination.state === "VERIFIED" &&
    payout.destination.referenceHash === payout.destinationHash, "Approve a request with a currently verified destination first.");
  const exactShop = { ...scope, shopId: payout.shopId };
  financeAssert(await db.marketplaceShop.findFirst({ where: { ...activeSellerMarket(scope.marketId), id: payout.shopId }, select: { id: true } }),
    "This seller market is inactive. Reject the request or review the existing payout attempt.");
  await ensureCurrentRefunds(db, exactShop);
  const current = await balances(db, exactShop);
  financeAssert(current.availableMinor >= 0, "A refund or adjustment reduced the funds reserved for this payout. Review the request.");
  await db.sellerFinancePayout.update({ where: { id: payout.id }, data: { status: "PROCESSING", attemptReference: reference } });
  await audit(db, exactShop, actor, payout.id, "PAYOUT_PROCESSING", {
    attemptReference: reference, destinationId: payout.destinationId, amountMinor: payout.amountMinor,
  });
}

export async function staffSellerFinanceAction(actorId: string, marketId: MarketId, raw: unknown) {
  checkEnvironment(marketId);
  const result = staffInput.safeParse(raw);
  financeAssert(result.success, "Enter valid synthetic evidence and operation details.", 400);
  const command = result.data;
  const scope = financeScope(marketId);
  const actor: Actor = { actorId, actorKind: "staff" };
  const db = getDb();
  if (command.kind === "payout-process") {
    await db.$transaction(async tx => {
      await checkStaff(tx, actorId, true);
      await startPayout(tx, scope, actor, command);
    });
    return db.$transaction(async tx => {
      await checkStaff(tx, actorId, true);
      return recordPayoutOutcome(tx, scope, actor, command);
    });
  }
  return db.$transaction(async tx => {
    await checkStaff(tx, actorId, true);
    if (command.kind === "policy-create") return savePolicy(tx, marketId, actor, command);
    if (command.kind === "payout-reconcile") return recordPayoutOutcome(tx, scope, actor, command);
    if (command.kind === "reconcile-order" || command.kind === "online-release") {
      await settlementOrderLock(tx, command.orderId);
      let order = await loadSettlementOrder(tx, marketId, command.orderId);
      if (command.kind === "online-release") {
        financeAssert(settlementPayment(order)?.online, "Match the original captured online payment first.");
        const hash = fingerprint({ scope, command });
        if (order.sellerFinanceFunding) {
          financeAssert(hash === order.sellerFinanceFunding.fingerprint, "This funding observation already has different evidence.");
        } else {
          const clash = await tx.sellerFinanceFunding.findFirst({ where: { OR: [{ operationId: command.operationId },
            { ...scope, testReference: command.testReference }] }, select: { orderId: true } });
          financeAssert(!clash, "Choose an unused synthetic funding operation reference.");
          await tx.sellerFinanceFunding.create({ data: { ...scope, orderId: order.id, actorId,
            operationId: command.operationId, testReference: command.testReference, reason: command.reason, fingerprint: hash } });
          await audit(tx, scope, actor, order.id, "ONLINE_FUNDING_OBSERVED", { operationId: command.operationId, reason: command.reason });
          order = await loadSettlementOrder(tx, marketId, command.orderId);
        }
      }
      return postOrderSettlement(tx, order, actorId);
    }
    if (command.kind === "destination-review") {
      const where = { ...scope, id: command.destinationId };
      const record = await tx.sellerFinanceDestination.findFirst({ where });
      financeAssert(record, "Destination unavailable in this market.", 404);
      await lockSellerScope(tx, record.shopId, marketId);
      await financeLock(tx, marketId, record.shopId);
      const destination = await tx.sellerFinanceDestination.findFirstOrThrow({ where });
      const next = command.decision === "VERIFY" ? "VERIFIED" : "REVOKED";
      if (destination.state === next) return { id: destination.id, state: next };
      financeAssert(next === "REVOKED" || destination.state === "PENDING" &&
        await tx.marketplaceShop.findFirst({ where: { ...activeSellerMarket(marketId), id: destination.shopId }, select: { id: true } }),
      "Only pending destinations in an active seller market can be verified.");
      await tx.sellerFinanceDestination.update({ where: { id: destination.id }, data: { state: next } });
      await audit(tx, { ...scope, shopId: destination.shopId }, actor, destination.id, `DESTINATION_${next}`, { reason: command.reason });
      return { id: destination.id, state: next };
    }
    const payout = await lockPayout(tx, scope, command.payoutId);
    const next = command.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (payout.status === next) return { id: payout.id, state: next };
    financeAssert(payout.status === "REQUESTED" || (next === "REJECTED" && payout.status === "APPROVED"),
      "This request can no longer be reviewed. Reconcile its existing attempt.");
    financeAssert(next === "REJECTED" || payout.destination.state === "VERIFIED", "This destination requires re-verification.");
    await tx.sellerFinancePayout.update({ where: { id: payout.id }, data: { status: next, reason: command.reason } });
    await audit(tx, { ...scope, shopId: payout.shopId }, actor, payout.id, `PAYOUT_${next}`, { reason: command.reason });
    return { id: payout.id, state: next };
  });
}
