import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrepaidCheckout } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import {
  prepaidCheckoutInput, prepaidSubmissionInput, type CheckoutQuote, type NormalizedPrepaidCheckout,
  type PrepaidPaymentResult, type ReviewResult,
} from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { equalDigest, requestDigest } from "./guest.ts";
import {
  calculateQuote, canonicalOrder, changeBangladeshStock, createBangladeshOrder, lockAttempt, lockQuoteRows, placedOrder, snapshotShops,
} from "./orders.ts";
import { prepaidAvailable } from "./prepaid-config.ts";
import { lookupPrepaidStatus, openPrepaidSession } from "./prepaid-provider.ts";
import { notifyOrder } from "./order-notifications.ts";

const openingTime = 3 * 60 * 1000;
const paymentTime = 30 * 60 * 1000;
const unavailable = { kind: "unavailable", message: "Online payment is unavailable for this checkout." } as const;
const conflict = { kind: "conflict", message: "This payment attempt is no longer available. Review the order again." } as const;
const pending = { kind: "pending", message: "Waiting for payment confirmation. Check the status before starting another order." } as const;
const abandoned = { kind: "abandoned", message: "This payment session has ended. Your cart is saved." } as const;

function quoteSnapshot(session: PrepaidCheckout) {
  if (!session.quote || typeof session.quote !== "object" || Array.isArray(session.quote)) {
    throw new Error("The order snapshot is unavailable.");
  }
  return session.quote as unknown as CheckoutQuote;
}

export async function reviewPrepaid(raw: unknown, guestKey: string): Promise<ReviewResult> {
  if (!prepaidAvailable()) return unavailable;
  const parsed = prepaidCheckoutInput.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", message: "Add a valid email address and check the delivery and order details." };
  const db = getDb();
  const input = canonicalOrder(parsed.data);
  const attemptId = randomUUID();
  const quote = await calculateQuote(db, input, guestKey, attemptId);
  await db.checkoutAttempt.create({ data: { id: attemptId, guestKey, requestHash: requestDigest(JSON.stringify(input)) } });
  return { kind: "review", attemptId, quote };
}

async function closePrepaid(tx: Prisma.TransactionClient, session: PrepaidCheckout) {
  await changeBangladeshStock(tx, quoteSnapshot(session), false);
  await tx.prepaidCheckout.update({
    where: { attemptId: session.attemptId },
    data: { state: "CLOSED", checkout: Prisma.DbNull, quote: Prisma.DbNull, marketplaceShopIds: Prisma.DbNull, redirectUrl: null, shopperId: null },
  });
  await tx.checkoutAttempt.update({ where: { id: session.attemptId }, data: { abandonedAt: new Date() } });
}

export async function startPrepaid(raw: unknown, guestKey: string, direct: boolean, shopperId?: string): Promise<PrepaidPaymentResult> {
  if (!prepaidAvailable()) return unavailable;
  const parsed = prepaidSubmissionInput.safeParse(raw);
  if (!parsed.success) return conflict;
  const input = canonicalOrder(parsed.data);
  const { attemptId, reviewToken } = parsed.data;
  const db = getDb();
  const phase = await db.$transaction(async tx => {
    // Limit each browser to one reservation. A repeat click resumes its existing attempt.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${guestKey}), 884)`;
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt || attempt.guestKey !== guestKey || attempt.requestHash !== requestDigest(JSON.stringify(input)) || attempt.abandonedAt) {
      return { result: conflict };
    }
    const session = await tx.prepaidCheckout.findUnique({ where: { attemptId } });
    const order = placedOrder(attempt);
    if (order && session) return { result: { ...order, direct: session.direct } };
    if (session) {
      const redirectUrl = session.redirectUrl;
      if (session.state === "AWAITING_PAYMENT" && session.expiresAt > new Date() && redirectUrl) {
        return { result: { kind: "continue", redirectUrl } as const };
      }
      return { result: pending };
    }
    const another = await tx.prepaidCheckout.findFirst({
      where: { attempt: { guestKey }, state: { in: ["PREPARING", "AWAITING_PAYMENT"] } }, select: { attemptId: true },
    });
    if (another) return { result: { kind: "conflict", message: "Check the status of your earlier online payment before starting another." } as const };

    await lockQuoteRows(tx, input);
    const quote = await calculateQuote(tx, input, guestKey, attemptId);
    if (!equalDigest(quote.reviewToken, reviewToken)) return { result: { kind: "changed", quote } as const };
    const shops = await snapshotShops(tx, quote);
    await changeBangladeshStock(tx, quote, true);
    const providerId = `GB${randomBytes(13).toString("hex")}`;
    await tx.prepaidCheckout.create({
      data: {
        attemptId, providerId, checkout: input, quote, marketplaceShopIds: shops, shopperId, direct,
        couponCode: quote.couponCode, expiresAt: new Date(Date.now() + openingTime),
      },
    });
    return { providerId, quote };
  });
  if ("result" in phase && phase.result) return phase.result;

  let redirectUrl: string | null = null;
  try {
    redirectUrl = await openPrepaidSession(phase.providerId, phase.quote);
  } catch {
    // Without a URL persisted in the attempt (and delivered to the buyer), the
    // newly opened session cannot receive a shopper payment.
  }
  if (!redirectUrl) {
    await db.$transaction(async tx => {
      await lockAttempt(tx, attemptId);
      const session = await tx.prepaidCheckout.findUnique({ where: { attemptId } });
      if (session?.state === "PREPARING") await closePrepaid(tx, session);
    });
    return { kind: "unavailable", message: "The payment page could not open. Review your order and try again." };
  }
  const updated = await db.prepaidCheckout.updateMany({
    where: { attemptId, state: "PREPARING" },
    data: { state: "AWAITING_PAYMENT", redirectUrl, expiresAt: new Date(Date.now() + paymentTime) },
  });
  return updated.count === 1 ? { kind: "continue", redirectUrl } : abandoned;
}

async function reconcilePrepaid(attemptId: string, validationHint?: string): Promise<PrepaidPaymentResult> {
  const db = getDb();
  const session = await db.prepaidCheckout.findUnique({ where: { attemptId } });
  if (!session) return conflict;
  const provider = session.state === "AWAITING_PAYMENT"
    ? await lookupPrepaidStatus(session.providerId, quoteSnapshot(session).totalMinor, validationHint) : null;

  let newOrder = false;
  const outcome = await db.$transaction(async (tx): Promise<PrepaidPaymentResult> => {
    const attempt = await lockAttempt(tx, attemptId);
    const current = await tx.prepaidCheckout.findUnique({ where: { attemptId } });
    if (!attempt || !current) return conflict;
    const result = placedOrder(attempt);
    if (result) return { ...result, direct: current.direct };
    if (current.state === "CLOSED") return abandoned;
    if ((current.state === "PREPARING" && current.expiresAt <= new Date()) ||
        (current.state === "AWAITING_PAYMENT" && provider?.kind === "closed")) {
      await closePrepaid(tx, current);
      return abandoned;
    }
    if (current.state !== "AWAITING_PAYMENT" || !provider || provider.kind === "pending") return pending;
    if (provider.kind === "review") {
      return { kind: "pending", message: "The payment needs verification. Contact support before paying again." };
    }
    if (provider.kind !== "paid") return pending;
    const quote = quoteSnapshot(current);
    const source = current.checkout as unknown as NormalizedPrepaidCheckout;
    const parsed = prepaidCheckoutInput.safeParse({
      ...source,
      customer: { ...source.customer, postalCode: source.customer.postalCode ?? undefined },
    });
    if (!parsed.success) throw new Error("The payment record could not be read.");
    const input = canonicalOrder(parsed.data);
    const shops = current.marketplaceShopIds as Record<string, string | null>;
    const shopper = current.shopperId
      ? await tx.shopper.findUnique({ where: { id: current.shopperId }, select: { id: true } }) : null;
    const order = await createBangladeshOrder(tx, input, quote, attemptId, shops, shopper?.id);
    await tx.prepaidCheckout.update({
      where: { attemptId }, data: {
        state: "PAID", bankTransactionId: provider.bankTransactionId, checkout: Prisma.DbNull, quote: Prisma.DbNull,
        marketplaceShopIds: Prisma.DbNull, redirectUrl: null, shopperId: null,
      },
    });
    newOrder = true;
    return { ...order, direct: current.direct };
  });
  if (newOrder && outcome.kind === "placed") await notifyOrder(outcome.orderId, "received");
  return outcome;
}

export async function recoverPrepaid(attemptId: string, guestKey: string, resume = false): Promise<PrepaidPaymentResult> {
  const attempt = await getDb().checkoutAttempt.findFirst({
    where: { id: attemptId, guestKey }, select: { prepaid: true },
  });
  if (!attempt?.prepaid) return abandoned;
  const { prepaid } = attempt;
  if (resume && prepaid.state === "AWAITING_PAYMENT" && prepaid.expiresAt > new Date() && prepaid.redirectUrl) {
    return { kind: "continue", redirectUrl: prepaid.redirectUrl };
  }
  return reconcilePrepaid(attemptId);
}

export async function acceptPrepaidCallback(providerId: string, validationHint?: string) {
  const session = await getDb().prepaidCheckout.findUnique({ where: { providerId }, select: { attemptId: true } });
  if (!session) return null;
  await reconcilePrepaid(session.attemptId, validationHint);
  return session.attemptId;
}

export async function reconcileExpiredPrepaid() {
  const stale = await getDb().prepaidCheckout.findMany({
    where: { state: { in: ["PREPARING", "AWAITING_PAYMENT"] }, expiresAt: { lt: new Date() } },
    orderBy: { expiresAt: "asc" }, take: 3,
    select: { attemptId: true },
  });
  await Promise.allSettled(stale.map(session => reconcilePrepaid(session.attemptId)));
}

export function prepaidError(error: unknown): PrepaidPaymentResult | null {
  return error instanceof CommerceError ? error.detail : null;
}
