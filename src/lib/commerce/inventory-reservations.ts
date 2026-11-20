import { z } from "zod";
import { markets } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { MAX_CART_LINES, MAX_QUANTITY, validVariantId } from "../cart/model.ts";
import { getDb } from "../db/client.ts";
import { marketIdInput } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { authorizeOrderOperation } from "../staff/operations.ts";
import { addressText } from "./address.ts";
import { uuid } from "./checkout-types.ts";
import { lockCommercialSeller } from "./commercial-access.ts";
import { equalDigest, requestDigest } from "./guest.ts";
import { lockVariantInventory } from "./location-inventory.ts";
import { readConnectedOffer } from "./market-offers.ts";
import { lockAttempt, lockVariantQuoteRows } from "./orders.ts";
import {
  applyInventoryMovement, eligibleInventoryPools, inventoryDestinationInput, lockInventoryMarketPolicy, lockInventoryRoutes,
} from "./physical-inventory.ts";

type Tx = Prisma.TransactionClient;
const sqlIntMax = 2_147_483_647;
const holdDurationMs = 30 * 60 * 1000;
const positiveMinor = z.int().min(1).max(sqlIntMax);
const quantityInput = z.int().min(1).max(MAX_QUANTITY);
const digestInput = z.string().regex(/^[a-f0-9]{64}$/);
const providerMethod = z.enum(["PAYPAL", "SSLCOMMERZ"]);
const paymentMethod = z.enum(["COD", "PAYPAL", "SSLCOMMERZ"]);
const guestFields = { guestKey: digestInput, checkoutHash: digestInput };
const reservationInput = z.strictObject({
  attemptId: uuid, ...guestFields, marketId: marketIdInput, paymentMethod,
  destination: inventoryDestinationInput,
  lines: z.array(z.strictObject({
    variantId: z.string().refine(validVariantId), offerId: uuid,
    revision: z.int().min(0).max(sqlIntMax), amountMinor: positiveMinor, quantity: quantityInput,
  })).min(1).max(MAX_CART_LINES).refine(lines => new Set(lines.map(line => line.variantId)).size === lines.length,
    "Combine repeated variant quantities before reserving stock."),
});
const providerFields = { marketId: marketIdInput, paymentMethod: providerMethod };
const releaseInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("guest"), ...guestFields }),
  z.strictObject({ kind: z.literal("provider-closed"), ...providerFields }),
]);
const settlementInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cod"), ...guestFields }),
  z.strictObject({ kind: z.literal("verified-payment"), ...providerFields,
    reference: addressText(1, 120), currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: positiveMinor, recovery: z.unknown().optional(),
  }),
]);
const dispatchInput = z.strictObject({
  allocationId: uuid, eventId: addressText(1, 120), reference: addressText(1, 120), quantity: quantityInput,
});
const restockInput = z.strictObject({ allocationId: uuid, caseId: uuid, orderItemId: uuid, quantity: quantityInput });
const reservationInclude = {
  allocations: { include: { pool: { select: {
    variantId: true, ownerId: true, locationId: true, variant: { select: { sku: true } },
  } } }, orderBy: { id: "asc" } },
} as const satisfies Prisma.InventoryReservationInclude;
type Reservation = Prisma.InventoryReservationGetPayload<{ include: typeof reservationInclude }>;
type Allocation = Reservation["allocations"][number];
type Attempt = NonNullable<Awaited<ReturnType<typeof lockAttempt>>>;
type ReservationInput = z.output<typeof reservationInput>;
type ReservationLine = ReservationInput["lines"][number];

export class InventoryReservationError extends Error {
  constructor(public readonly code: "invalid" | "conflict" | "delivery_unavailable" | "out_of_stock", message: string) {
    super(message);
  }
}

function fail(code: InventoryReservationError["code"], message: string): never {
  throw new InventoryReservationError(code, message);
}

function read<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  return parsed.success ? parsed.data : fail("invalid", "The inventory request is incomplete or invalid.");
}

function requireGuest(attempt: Attempt, proof: { guestKey: string; checkoutHash: string }) {
  if (!equalDigest(attempt.guestKey, proof.guestKey) || !equalDigest(attempt.requestHash, proof.checkoutHash)) {
    fail("conflict", "The inventory request does not match this checkout attempt.");
  }
}

async function lockedReservation(tx: Tx, rawAttemptId: string) {
  const attemptId = read(uuid, rawAttemptId);
  const attempt = await lockAttempt(tx, attemptId);
  if (!attempt) fail("conflict", "The checkout attempt is unavailable.");
  const reservation = await tx.inventoryReservation.findUnique({ where: { attemptId }, include: reservationInclude });
  return { attempt, reservation };
}

async function adjustReserved(tx: Tx, poolId: string, delta: number) {
  const updated = await tx.$executeRaw`
    UPDATE "InventoryPool" SET "reserved" = "reserved" + ${delta}::int, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${poolId}::uuid AND ${delta}::int BETWEEN -"reserved" AND "onHand" - "reserved"
  `;
  if (updated !== 1) fail(delta > 0 ? "out_of_stock" : "conflict", "The stock balance changed during reservation.");
}

async function releaseAllocations(tx: Tx, reservation: Reservation) {
  await lockVariantInventory(tx, reservation.allocations.map(item => item.pool.variantId));
  for (const allocation of reservation.allocations) await adjustReserved(tx, allocation.poolId, -allocation.quantity);
}

async function releaseHold(tx: Tx, reservation: Reservation, state: "RELEASED" | "EXPIRED", now: Date) {
  await releaseAllocations(tx, reservation);
  await tx.checkoutAttempt.updateMany({ where: { id: reservation.attemptId, abandonedAt: null }, data: { abandonedAt: now } });
  return tx.inventoryReservation.update({ where: { id: reservation.id }, data: { state }, include: reservationInclude });
}

function reservationTerms(input: ReservationInput) {
  const destination = { ...input.destination, postalCode: input.destination.postalCode ?? null };
  const lines = [...input.lines].sort((left, right) => left.variantId < right.variantId ? -1 : left.variantId > right.variantId ? 1 : 0);
  const requestHash = requestDigest(JSON.stringify([input.marketId, input.paymentMethod, destination, lines]));
  return { destination, lines, requestHash };
}

async function lockReservationTerms(tx: Tx, marketId: ReservationInput["marketId"],
  lines: readonly ReservationLine[], destination: ReservationInput["destination"]) {
  const variantIds = lines.map(line => line.variantId);
  // This takes the shared variant inventory advisory lock before offer and catalog locks.
  await lockVariantQuoteRows(tx, marketId, variantIds);
  const identities = await tx.marketOffer.findMany({
    where: { marketId, variantId: { in: variantIds } }, select: { identity: { select: { sellerId: true } } },
  });
  const sellers = new Set(identities.flatMap(item => item.identity ? [item.identity.sellerId] : []));
  for (const sellerId of [...sellers].sort()) await lockCommercialSeller(tx, sellerId);
  await lockInventoryMarketPolicy(tx, marketId, destination);
  await lockInventoryRoutes(tx, variantIds);
}

async function currentAcceptedOffer(tx: Tx, marketId: ReservationInput["marketId"], line: ReservationLine, now: Date) {
  const offer = await readConnectedOffer(line.variantId, marketId, tx, now);
  return offer?.eligible && offer.id === line.offerId && offer.revision === line.revision && offer.amountMinor === line.amountMinor ? offer : null;
}

/** Called by trusted checkout code after checking the guest and review token. */
export async function reserveInventory(tx: Tx, raw: unknown, now = new Date()) {
  const input = read(reservationInput, raw);
  const { attempt, reservation } = await lockedReservation(tx, input.attemptId);
  requireGuest(attempt, input);
  if (attempt.marketId !== input.marketId || attempt.paymentMethod !== input.paymentMethod) {
    fail("conflict", "The reservation market or payment method changed.");
  }
  const { destination, lines, requestHash } = reservationTerms(input);
  if (reservation) {
    if (!equalDigest(reservation.requestHash, requestHash)) fail("conflict", "This reservation key already recorded different checkout terms.");
    if (reservation.state === "HELD" && attempt.order) fail("conflict", "Reconcile the existing order before changing this hold.");
    if (reservation.state === "HELD" && (reservation.expiresAt <= now || attempt.abandonedAt)) {
      return releaseHold(tx, reservation, attempt.abandonedAt ? "RELEASED" : "EXPIRED", now);
    }
    return reservation;
  }
  if (attempt.abandonedAt || attempt.order) fail("conflict", "Start a new review before reserving inventory.");

  await lockReservationTerms(tx, input.marketId, lines, destination);

  const allocations: Prisma.InventoryAllocationUncheckedCreateWithoutReservationInput[] = [];
  for (const line of lines) {
    const offer = await currentAcceptedOffer(tx, input.marketId, line, now);
    if (!offer) fail("conflict", "An accepted offer changed. Review the current purchase terms.");
    const fulfillment = await eligibleInventoryPools(tx, {
      variantId: line.variantId, ownerId: offer.sellerId, marketId: input.marketId, paymentMethod: input.paymentMethod, destination,
    });
    if (fulfillment.kind === "delivery_unavailable") fail("delivery_unavailable", "Delivery is unavailable for this destination.");
    let remaining = line.quantity;
    for (const pool of fulfillment.pools) {
      const quantity = Math.min(remaining, pool.onHand - pool.reserved);
      if (quantity <= 0) continue;
      await adjustReserved(tx, pool.id, quantity);
      allocations.push({ poolId: pool.id, offerId: offer.id, quantity, amountMinor: offer.amountMinor,
        currency: offer.currency, offerRevision: offer.revision });
      remaining -= quantity;
      if (!remaining) break;
    }
    if (remaining) fail("out_of_stock", "Stock changed. Review your requested quantities.");
  }
  return tx.inventoryReservation.create({ data: {
    attemptId: input.attemptId, marketId: input.marketId, paymentMethod: input.paymentMethod, requestHash,
    expiresAt: new Date(now.getTime() + holdDurationMs), allocations: { create: allocations },
  }, include: reservationInclude });
}

/** Prepaid holds can be released early only after the trusted provider adapter verifies closure. */
export async function releaseInventoryReservation(tx: Tx, attemptId: string, proof: unknown, now = new Date()) {
  const confirmation = read(releaseInput, proof);
  const { attempt, reservation } = await lockedReservation(tx, attemptId);
  if (!reservation) fail("conflict", "The inventory reservation is unavailable.");
  if (confirmation.kind === "guest") {
    requireGuest(attempt, confirmation);
    if (reservation.paymentMethod !== "COD") fail("conflict", "Verify provider closure before releasing prepaid inventory.");
  } else if (confirmation.marketId !== reservation.marketId || confirmation.paymentMethod !== reservation.paymentMethod) {
    fail("conflict", "The verified provider closure does not match the reservation.");
  }
  if (confirmation.kind === "provider-closed" && reservation.state === "EXPIRED") {
    // The sweeper already returned these units. Explicit provider closure rules out later reacquisition.
    return tx.inventoryReservation.update({ where: { id: reservation.id }, data: { state: "RELEASED" }, include: reservationInclude });
  }
  if (reservation.state !== "HELD") return reservation;
  if (attempt.order) fail("conflict", "Reconcile the existing order before changing this hold.");
  return releaseHold(tx, reservation, "RELEASED", now);
}

export async function expireInventoryReservations(now = new Date(), take = 100, variantIds?: readonly string[]) {
  if (variantIds?.length === 0) return 0;
  const db = getDb();
  const candidates = await db.inventoryReservation.findMany({
    where: { state: "HELD", expiresAt: { lte: now },
      ...(variantIds && { allocations: { some: { pool: { variantId: { in: [...new Set(variantIds)] } } } } }),
    },
    select: { attemptId: true }, orderBy: [{ expiresAt: "asc" }, { attemptId: "asc" }],
    take: read(z.int().min(1).max(100), take),
  });
  let expired = 0;
  for (const { attemptId } of candidates) {
    expired += await db.$transaction(async tx => {
      const { attempt, reservation } = await lockedReservation(tx, attemptId);
      if (reservation?.state !== "HELD" || reservation.expiresAt > now || attempt.order) return 0;
      await releaseHold(tx, reservation, attempt.abandonedAt ? "RELEASED" : "EXPIRED", now);
      return 1;
    });
  }
  return expired;
}

type Settlement = z.output<typeof settlementInput>;
type VerifiedPayment = Extract<Settlement, { kind: "verified-payment" }>;
type CreateOrder = (tx: Tx, reservation: Reservation) => Promise<string>;
type Outcome =
  | { kind: "committed" | "cancelled"; reservationId: string; orderId: string }
  | { kind: "expired"; reservationId: string }
  | { kind: "refund_required"; reservationId: string; providerReference: string; amountMinor: number; currency: string; newlyRecorded: boolean };

function refundRequired(reservation: Reservation, payment: VerifiedPayment, newlyRecorded: boolean): Outcome {
  return { kind: "refund_required", reservationId: reservation.id, providerReference: payment.reference,
    amountMinor: payment.amountMinor, currency: payment.currency, newlyRecorded };
}

async function reacquireExpiredReservation(tx: Tx, attempt: Attempt, reservation: Reservation, raw: unknown, now: Date) {
  if (reservation.state !== "EXPIRED") return false;
  const parsed = reservationInput.safeParse(raw);
  if (!parsed.success) return false;
  const input = parsed.data;
  if (input.attemptId !== attempt.id || input.marketId !== reservation.marketId || input.paymentMethod !== reservation.paymentMethod ||
    !equalDigest(input.guestKey, attempt.guestKey) || !equalDigest(input.checkoutHash, attempt.requestHash)) return false;
  const { destination, lines, requestHash } = reservationTerms(input);
  if (!equalDigest(requestHash, reservation.requestHash)) return false;

  await lockReservationTerms(tx, input.marketId, lines, destination);
  let checked = 0;
  for (const line of lines) {
    const offer = await currentAcceptedOffer(tx, input.marketId, line, now);
    if (!offer) return false;
    const fulfillment = await eligibleInventoryPools(tx, {
      variantId: line.variantId, ownerId: offer.sellerId, marketId: input.marketId, paymentMethod: input.paymentMethod, destination,
    });
    if (fulfillment.kind !== "available") return false;
    const original = reservation.allocations.filter(allocation => allocation.pool.variantId === line.variantId);
    if (original.reduce((total, allocation) => total + allocation.quantity, 0) !== line.quantity) return false;
    for (const allocation of original) {
      const available = fulfillment.pools.find(pool => pool.id === allocation.poolId)?.available ?? 0;
      if (available < allocation.quantity || allocation.offerId !== offer.id || allocation.offerRevision !== offer.revision ||
        allocation.currency !== offer.currency || allocation.amountMinor !== offer.amountMinor) return false;
    }
    checked += original.length;
  }
  if (checked !== reservation.allocations.length) return false;
  for (const allocation of reservation.allocations) await adjustReserved(tx, allocation.poolId, allocation.quantity);
  await tx.checkoutAttempt.update({ where: { id: attempt.id }, data: { abandonedAt: null } });
  return true;
}

async function validateNewOrder(tx: Tx, orderId: string, reservation: Reservation, payment?: VerifiedPayment) {
  const order = await tx.order.findUnique({
    where: { id: read(uuid, orderId) }, include: { payment: true, items: true },
  });
  const localCurrency = markets[reservation.marketId].currency;
  const method = reservation.paymentMethod;
  if (!order || order.attemptId !== reservation.attemptId || order.marketId !== reservation.marketId ||
    order.status !== "PLACED" || order.currency !== localCurrency || order.payment?.method !== method ||
    order.payment.currency !== localCurrency || order.payment.amountMinor !== order.totalMinor ||
    (method === "COD" ? order.payment.status !== "AWAITING_COLLECTION" :
      order.payment.status !== "PAID" || order.totalMinor !== payment?.amountMinor)) {
    fail("conflict", "The accepted order does not match the checkout reservation and payment.");
  }
  const remaining = new Map<string, { quantity: number; amountMinor: number; ownerId: string; offerId: string; sku: string }>();
  for (const allocation of reservation.allocations) {
    const { variantId, ownerId, variant } = allocation.pool;
    const current = remaining.get(variantId);
    remaining.set(variantId, { quantity: (current?.quantity ?? 0) + allocation.quantity,
      amountMinor: allocation.amountMinor, ownerId, offerId: allocation.offerId, sku: variant.sku });
  }
  for (const line of order.items) {
    const expected = remaining.get(line.variantId);
    if (!expected && !line.offerIdSnapshot) {
      // A mixed order uses the legacy allocator only for its separate, unmanaged lines.
      if (await tx.variant.findFirst({ where: { id: line.variantId, managedInventory: true }, select: { id: true } })) {
        fail("conflict", "The accepted order omitted a managed variant reservation.");
      }
      continue;
    }
    if (!expected || line.quantity <= 0 || expected.quantity < line.quantity || line.currency !== localCurrency || expected.sku !== line.sku ||
      expected.offerId !== line.offerIdSnapshot || expected.amountMinor !== line.unitPriceMinor - line.unitDiscountMinor ||
      expected.ownerId !== (line.marketplaceShopId ?? storeShop.id)) {
      fail("conflict", "The accepted order lines do not match the reserved variants, prices and sellers.");
    }
    expected.quantity -= line.quantity;
  }
  if ([...remaining.values()].some(item => item.quantity)) fail("conflict", "The accepted order omitted a reserved quantity.");
}

/**
 * The order factory must write the actual native order and payment on this transaction.
 * Only the existing provider verifier may supply a verified-payment confirmation.
 */
export async function finalizeInventoryReservation(tx: Tx, attemptId: string, proof: unknown, createOrder: CreateOrder,
  now = new Date()): Promise<Outcome> {
  const confirmation = read(settlementInput, proof);
  const { attempt, reservation } = await lockedReservation(tx, attemptId);
  if (!reservation) fail("conflict", "The inventory reservation is unavailable.");
  const payment = confirmation.kind === "verified-payment" ? confirmation : undefined;
  if (confirmation.kind === "cod") {
    requireGuest(attempt, confirmation);
    if (reservation.paymentMethod !== "COD") fail("conflict", "This reservation requires verified prepaid payment.");
  } else {
    if (confirmation.paymentMethod !== reservation.paymentMethod || confirmation.marketId !== reservation.marketId ||
      confirmation.currency !== markets[reservation.marketId].currency) fail("conflict", "The verified payment is outside the reservation scope.");
    if (reservation.paymentReference && (reservation.paymentReference !== confirmation.reference ||
      reservation.paymentAmountMinor !== confirmation.amountMinor || reservation.paymentCurrency !== confirmation.currency)) {
      fail("conflict", "A different payment already closed this inventory reservation.");
    }
    // Serialize duplicate provider references across different checkout attempts.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${confirmation.paymentMethod + ":" + confirmation.reference}), 525)`;
    const duplicate = await tx.inventoryReservation.findFirst({
      where: { id: { not: reservation.id }, paymentMethod: confirmation.paymentMethod, paymentReference: confirmation.reference }, select: { id: true },
    });
    if (duplicate) fail("conflict", "The verified payment already belongs to another reservation.");
  }

  if ((reservation.state === "COMMITTED" || reservation.state === "CANCELLED") && reservation.orderId) {
    return { kind: reservation.state === "COMMITTED" ? "committed" : "cancelled", reservationId: reservation.id, orderId: reservation.orderId };
  }
  if (attempt.order) fail("conflict", "The order must be created with its inventory commitment.");
  if (reservation.state === "PAYMENT_EXCEPTION" && payment) return refundRequired(reservation, payment, false);
  const late = reservation.state !== "HELD" || reservation.expiresAt <= now || attempt.abandonedAt !== null;
  if (late) {
    const closed = reservation.state === "HELD"
      ? await releaseHold(tx, reservation, attempt.abandonedAt ? "RELEASED" : "EXPIRED", now)
      : reservation;
    if (!payment) return { kind: "expired", reservationId: reservation.id };
    if (!await reacquireExpiredReservation(tx, attempt, closed, payment.recovery, now)) {
      await tx.inventoryReservation.update({ where: { id: reservation.id }, data: {
        state: "PAYMENT_EXCEPTION", exceptionReason: "HOLD_CLOSED_BEFORE_VERIFIED_PAYMENT",
        paymentReference: payment.reference, paymentAmountMinor: payment.amountMinor, paymentCurrency: markets[payment.marketId].currency,
      } });
      return refundRequired(reservation, payment, true);
    }
  }
  const orderId = await createOrder(tx, reservation);
  await validateNewOrder(tx, orderId, reservation, payment);
  await tx.inventoryReservation.update({ where: { id: reservation.id }, data: {
    state: "COMMITTED", orderId, ...(payment && {
      paymentReference: payment.reference, paymentAmountMinor: payment.amountMinor, paymentCurrency: markets[payment.marketId].currency,
    }),
  } });
  // Committed stock remains physically present and reserved until dispatch or approved cancellation.
  return { kind: "committed", reservationId: reservation.id, orderId };
}

/** Run after the native order cancellation in the same transaction, with the attempt locked first. */
export async function cancelInventoryCommitment(tx: Tx, actorId: string, attemptId: string, verifiedPayPalRefundId?: string) {
  const { reservation, attempt } = await lockedReservation(tx, attemptId);
  if (!reservation?.orderId || attempt.order?.id !== reservation.orderId) fail("conflict", "The committed order is unavailable.");
  if (verifiedPayPalRefundId) {
    const refunded = await tx.payPalCheckout.findFirst({
      where: { attemptId, refundId: verifiedPayPalRefundId, refundActorId: actorId, refundStartedAt: { not: null },
        attempt: { order: { id: reservation.orderId, payment: { method: "PAYPAL", status: "REFUNDED" } } } },
      select: { attemptId: true },
    });
    if (!refunded || reservation.paymentMethod !== "PAYPAL") fail("conflict", "The confirmed refund does not match this purchase.");
  } else {
    await authorizeOrderOperation(tx, actorId, reservation.marketId, true);
  }
  if (reservation.state === "CANCELLED") return reservation;
  if (reservation.state !== "COMMITTED" || attempt.order.status !== "CANCELLED" || reservation.allocations.some(item => item.dispatched)) {
    fail("conflict", "Only an approved, undispatched order cancellation can release committed stock.");
  }
  await releaseAllocations(tx, reservation);
  return tx.inventoryReservation.update({ where: { id: reservation.id }, data: { state: "CANCELLED" }, include: reservationInclude });
}

async function committedAllocation(tx: Tx, actorId: string, attemptId: string, allocationId: string) {
  const { reservation, attempt } = await lockedReservation(tx, attemptId);
  if (!reservation || reservation.state !== "COMMITTED" || !reservation.orderId || attempt.order?.id !== reservation.orderId ||
    attempt.order.status !== "PLACED") fail("conflict", "The inventory allocation is not attached to an active order.");
  await authorizeOrderOperation(tx, actorId, reservation.marketId);
  const allocation = reservation.allocations.find(item => item.id === allocationId);
  if (!allocation) fail("conflict", "The inventory allocation does not belong to this order.");
  await lockVariantInventory(tx, [allocation.pool.variantId]);
  return { allocation, orderId: reservation.orderId };
}

async function recordedMovement(tx: Tx, allocation: Allocation, idempotencyKey: string) {
  return tx.inventoryMovement.findUnique({ where: { poolId_idempotencyKey: { poolId: allocation.poolId, idempotencyKey } }, select: { id: true } });
}

export async function dispatchInventoryAllocation(tx: Tx, actorId: string, attemptId: string, raw: unknown) {
  const input = read(dispatchInput, raw);
  const { allocation } = await committedAllocation(tx, actorId, attemptId, input.allocationId);
  const idempotencyKey = requestDigest(JSON.stringify(["dispatch", allocation.id, input.eventId]));
  if (input.quantity > allocation.quantity - allocation.dispatched && !await recordedMovement(tx, allocation, idempotencyKey)) {
    fail("conflict", "The dispatch exceeds the committed undispatched quantity.");
  }
  const result = await applyInventoryMovement(tx, {
    poolId: allocation.poolId, allocationId: allocation.id, idempotencyKey, kind: "DISPATCH", quantity: -input.quantity,
    reservedDelta: -input.quantity, reason: "Order allocation dispatch", reference: input.reference, actorId,
  });
  if (!result.replayed) await tx.inventoryAllocation.update({ where: { id: allocation.id }, data: { dispatched: { increment: input.quantity } } });
  return result;
}

export async function restockInventoryAllocation(tx: Tx, actorId: string, attemptId: string, raw: unknown) {
  const input = read(restockInput, raw);
  const { allocation, orderId } = await committedAllocation(tx, actorId, attemptId, input.allocationId);
  const reference = `${input.caseId}/${input.orderItemId}`;
  const idempotencyKey = requestDigest(JSON.stringify(["return", allocation.id, reference]));
  const replays = await recordedMovement(tx, allocation, idempotencyKey);
  if (!replays) {
    const approved = await tx.orderCaseReturnLine.findFirst({ where: {
      caseId: input.caseId, orderItemId: input.orderItemId, orderItem: { orderId, variantId: allocation.pool.variantId },
      orderCase: { orderId, kind: { in: ["RETURN", "EXCHANGE"] }, returnDisposition: "RESTOCK", returnReceivedAt: { not: null } },
    }, select: { quantity: true } });
    const posted = await tx.inventoryMovement.aggregate({ where: { kind: "RETURN", reference }, _sum: { quantity: true } });
    if (!approved || input.quantity + (posted._sum.quantity ?? 0) > approved.quantity ||
      input.quantity > allocation.dispatched - allocation.returned) {
      fail("conflict", "The returned quantity needs matching inspection approval and dispatched stock.");
    }
  }
  const result = await applyInventoryMovement(tx, {
    poolId: allocation.poolId, allocationId: allocation.id, idempotencyKey, kind: "RETURN", quantity: input.quantity,
    reason: "Inspected return approved for restock", reference, actorId,
  });
  if (!result.replayed) await tx.inventoryAllocation.update({ where: { id: allocation.id }, data: { returned: { increment: input.quantity } } });
  return result;
}
