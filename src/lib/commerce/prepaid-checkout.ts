import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrepaidCheckout } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import type { MarketId } from "../../config/markets.ts";
import {
  prepaidCheckoutInput, prepaidSubmissionInput, type CheckoutQuote, type NormalizedPrepaidCheckout,
  type PrepaidPaymentResult, type ReviewResult,
} from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { equalDigest, requestDigest } from "./guest.ts";
import {
  calculateQuote, canonicalOrder, createNativeOrder, lockAttempt, lockQuoteRows, placedOrder, snapshotShops,
} from "./orders.ts";
import { legacyPurchaseStock, placeReservedPurchase, purchaseContext, releasePurchaseStock, reservePurchaseStock } from "./checkout-inventory.ts";
import { expireInventoryReservations } from "./inventory-reservations.ts";
import { prepaidAvailable } from "./prepaid-config.ts";
import { lookupPrepaidStatus, openPrepaidSession } from "./prepaid-provider.ts";
import { providerMarket, type CommercialTerms } from "./market-commerce.ts";

const openingTime = 3 * 60 * 1000;
const paymentTime = 30 * 60 * 1000;
const unavailable = { kind: "unavailable", message: "Online payment is unavailable for this checkout." } as const;
const conflict = { kind: "conflict", message: "This payment attempt is no longer available. Review the order again." } as const;
const pending = { kind: "pending", message: "Waiting for payment confirmation. Check the status before starting another order." } as const;
const abandoned = { kind: "abandoned", message: "This payment session has ended. Your cart is saved." } as const;
const refundReview = { kind: "pending", message: "Payment arrived after the stock hold ended. Your cart is saved and the refund needs reconciliation. Contact support before paying again." } as const;

function quoteSnapshot(session: PrepaidCheckout) {
  if (!session.quote || typeof session.quote !== "object" || Array.isArray(session.quote)) {
    throw new Error("The order snapshot is unavailable.");
  }
  return session.quote as unknown as CheckoutQuote & { commercial?: CommercialTerms };
}

export async function reviewPrepaid(raw: unknown, guestKey: string, marketId: MarketId | undefined = providerMarket("SSLCOMMERZ")): Promise<ReviewResult> {
  if (!marketId || !prepaidAvailable(marketId)) return unavailable;
  const parsed = prepaidCheckoutInput.safeParse(raw);
  if (!parsed.success || parsed.data.marketId !== marketId) return { kind: "invalid", message: "Add a valid email address and check the delivery and order details." };
  const db = getDb();
  const input = canonicalOrder(parsed.data);
  if (input.items.some(item => item.offerId)) await expireInventoryReservations(new Date(), 20);
  const attemptId = randomUUID();
  const quote = await calculateQuote(db, input, guestKey, attemptId);
  await db.checkoutAttempt.create({ data: {
    id: attemptId, guestKey, marketId, paymentMethod: input.paymentMethod, requestHash: requestDigest(JSON.stringify(input)),
    commerceEvidence: quote.commercial.evidence, commercialSnapshot: quote.commercial,
  } });
  return { kind: "review", attemptId, quote };
}

async function closePrepaid(tx: Prisma.TransactionClient, session: PrepaidCheckout, marketId: MarketId) {
  await releasePurchaseStock(tx, session.attemptId, marketId, "SSLCOMMERZ",
    legacyPurchaseStock(session.stockAllocations, quoteSnapshot(session).lines));
  await tx.prepaidCheckout.update({
    where: { attemptId: session.attemptId },
    data: { state: "CLOSED", checkout: Prisma.DbNull, quote: Prisma.DbNull, marketplaceShopIds: Prisma.DbNull,
      stockAllocations: Prisma.DbNull, redirectUrl: null, shopperId: null },
  });
  await tx.checkoutAttempt.update({ where: { id: session.attemptId }, data: { abandonedAt: new Date() } });
}

export async function startPrepaid(raw: unknown, guestKey: string, direct: boolean, shopperId?: string,
  marketId: MarketId | undefined = providerMarket("SSLCOMMERZ")): Promise<PrepaidPaymentResult> {
  if (!marketId || !prepaidAvailable(marketId)) return unavailable;
  const parsed = prepaidSubmissionInput.safeParse(raw);
  if (!parsed.success || parsed.data.marketId !== marketId) return conflict;
  const input = canonicalOrder(parsed.data);
  const { attemptId, reviewToken } = parsed.data;
  const db = getDb();
  const phase = await db.$transaction(async tx => {
    // Limit each browser to one reservation. A repeat click resumes its existing attempt.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${guestKey}), 884)`;
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt || attempt.guestKey !== guestKey || attempt.requestHash !== requestDigest(JSON.stringify(input)) || attempt.abandonedAt ||
        (attempt.marketId && attempt.marketId !== marketId) || (attempt.paymentMethod && attempt.paymentMethod !== "SSLCOMMERZ")) {
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
      where: { attempt: { guestKey, marketId }, state: { in: ["PREPARING", "AWAITING_PAYMENT"] } }, select: { attemptId: true },
    });
    if (another) return { result: { kind: "conflict", message: "Check the status of your earlier online payment before starting another." } as const };

    await lockQuoteRows(tx, input);
    const quote = await calculateQuote(tx, input, guestKey, attemptId);
    if (!equalDigest(quote.reviewToken, reviewToken)) return { result: { kind: "changed", quote } as const };
    const shops = await snapshotShops(tx, quote);
    await tx.checkoutAttempt.update({ where: { id: attemptId }, data: {
      marketId, paymentMethod: input.paymentMethod, commerceEvidence: quote.commercial.evidence, commercialSnapshot: quote.commercial,
    } });
    const stockAllocations = await reservePurchaseStock(tx, purchaseContext(input, attemptId, guestKey, attempt.requestHash), quote.lines);
    const providerId = `GB${randomBytes(13).toString("hex")}`;
    await tx.prepaidCheckout.create({
      data: {
        attemptId, providerId, checkout: input, quote, marketplaceShopIds: shops, stockAllocations, shopperId, direct,
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
      if (session?.state === "PREPARING") await closePrepaid(tx, session, marketId);
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

  return db.$transaction(async tx => {
    const attempt = await lockAttempt(tx, attemptId);
    const current = await tx.prepaidCheckout.findUnique({ where: { attemptId } });
    if (!attempt || !current) return conflict;
    const result = placedOrder(attempt);
    if (result) return { ...result, direct: current.direct };
    if (current.state === "CLOSED") {
      const exception = await tx.inventoryReservation.findUnique({ where: { attemptId }, select: { state: true } });
      return exception?.state === "PAYMENT_EXCEPTION" ? refundReview : abandoned;
    }
    if (current.state === "AWAITING_PAYMENT" && provider && "failed" in provider && provider.failed && !current.providerFailedAt) {
      await tx.prepaidCheckout.update({ where: { attemptId }, data: {
        providerFailedAt: new Date(), providerFailureCode: "FAILED",
      } });
    }
    if ((current.state === "PREPARING" && current.expiresAt <= new Date()) ||
        (current.state === "AWAITING_PAYMENT" && provider?.kind === "closed")) {
      const marketId = attempt.marketId ?? providerMarket("SSLCOMMERZ");
      if (!marketId) return pending;
      await closePrepaid(tx, current, marketId);
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
    if (!parsed.success || (attempt.marketId && parsed.data.marketId !== attempt.marketId)) throw new Error("The payment record could not be read.");
    const input = canonicalOrder(parsed.data);
    const shops = current.marketplaceShopIds as Record<string, string | null>;
    const shopper = current.shopperId
      ? await tx.shopper.findUnique({ where: { id: current.shopperId }, select: { id: true } }) : null;
    const context = purchaseContext(input, attemptId, attempt.guestKey, attempt.requestHash);
    const order = await placeReservedPurchase(tx, context, quote.lines, legacyPurchaseStock(current.stockAllocations, quote.lines),
      (sameTransaction, allocations) => createNativeOrder(sameTransaction, input, quote, attemptId, shops, allocations, shopper?.id),
      { reference: provider.bankTransactionId, currency: quote.currency, amountMinor: quote.totalMinor });
    await tx.prepaidCheckout.update({
      where: { attemptId }, data: {
        state: order.kind === "placed" ? "PAID" : "CLOSED", bankTransactionId: provider.bankTransactionId, checkout: Prisma.DbNull, quote: Prisma.DbNull,
        marketplaceShopIds: Prisma.DbNull, stockAllocations: Prisma.DbNull, redirectUrl: null, shopperId: null,
      },
    });
    if (order.kind === "refund_required") return refundReview;
    return { ...order, direct: current.direct };
  });
}

export async function recoverPrepaid(attemptId: string, guestKey: string, resume = false,
  marketId: MarketId | undefined = providerMarket("SSLCOMMERZ")): Promise<PrepaidPaymentResult> {
  if (!marketId) return abandoned;
  const attempt = await getDb().checkoutAttempt.findFirst({
    where: { id: attemptId, guestKey, marketId }, select: { prepaid: true },
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

export async function reconcileExpiredPrepaid(marketId: MarketId | undefined = providerMarket("SSLCOMMERZ")) {
  if (!marketId) return;
  await expireInventoryReservations();
  const stale = await getDb().prepaidCheckout.findMany({
    where: { attempt: { marketId }, state: { in: ["PREPARING", "AWAITING_PAYMENT"] }, expiresAt: { lt: new Date() } },
    orderBy: { expiresAt: "asc" }, take: 3,
    select: { attemptId: true },
  });
  await Promise.allSettled(stale.map(session => reconcilePrepaid(session.attemptId)));
}

export function prepaidError(error: unknown): PrepaidPaymentResult | null {
  return error instanceof CommerceError ? error.detail : null;
}
