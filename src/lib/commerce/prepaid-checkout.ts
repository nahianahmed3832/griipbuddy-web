import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrepaidCheckout } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import type { MarketId } from "../../config/markets.ts";
import {
  prepaidCheckoutInput, prepaidSubmissionInput, type CheckoutQuote, type NormalizedPrepaidCheckout,
  type PrepaidPaymentResult, type ReviewResult,
} from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { scopedCatalogPilotRequested } from "../catalog/main-admin-config.ts";
import { pilotCheckoutScope, pilotQuoteScope } from "./scoped-pilot-checkout.ts";
import { equalDigest, requestDigest } from "./guest.ts";
import {
  calculateQuote, canonicalOrder, checkoutReviewActor, createNativeOrder, lockAttempt, lockQuoteRows, newQuoteExpiry, placedOrder,
  repriceCheckoutReview, snapshotShops, validateCheckoutCart, validateReviewActor,
} from "./orders.ts";
import { legacyPurchaseStock, placeReservedPurchase, purchaseContext, releasePurchaseStock, reservePurchaseStock } from "./checkout-inventory.ts";
import { expireInventoryReservations } from "./inventory-reservations.ts";
import { prepaidAvailable, prepaidConfig } from "./prepaid-config.ts";
import { lookupPrepaidStatus, openPrepaidSession } from "./prepaid-provider.ts";
import { providerMarket, type CommercialTerms } from "./market-commerce.ts";
import { finishPaymentEvent, paymentEventDigest, recordPaymentEvent } from "./provider-payment-events.ts";

const openingTime = 3 * 60 * 1000;
const paymentTime = 30 * 60 * 1000;
const unavailable = { kind: "unavailable", message: "Online payment is unavailable for this checkout." } as const;
const conflict = { kind: "conflict", message: "This payment attempt is no longer available. Review the order again." } as const;
const pending = { kind: "pending", message: "Waiting for payment confirmation. Check the status before starting another order." } as const;
const abandoned = { kind: "abandoned", message: "This payment session has ended. Your cart is saved." } as const;
const accountReview = { kind: "pending", message: "This payment needs merchant account reconciliation. Your cart is saved." } as const;
const verificationReview = { kind: "pending", message: "The payment needs verification. Contact support before paying again." } as const;
const refundReview = { kind: "pending", message: "Payment arrived after the stock hold ended. Your cart is saved and the refund needs reconciliation. Contact support before paying again." } as const;

export class PrepaidCallbackIdentityError extends Error {
  constructor() { super("The provider callback did not match the recorded payment account or transaction."); }
}

function quoteSnapshot(session: PrepaidCheckout) {
  if (!session.quote || typeof session.quote !== "object" || Array.isArray(session.quote)) {
    throw new Error("The order snapshot is unavailable.");
  }
  return session.quote as unknown as CheckoutQuote & { commercial?: CommercialTerms };
}

export async function reviewPrepaid(raw: unknown, guestKey: string, marketId: MarketId | undefined = providerMarket("SSLCOMMERZ"),
  shopperId?: string | null): Promise<ReviewResult> {
  if (!marketId || !prepaidAvailable(marketId)) return unavailable;
  const parsed = prepaidCheckoutInput.safeParse(raw);
  if (!parsed.success || parsed.data.marketId !== marketId) return { kind: "invalid", message: "Add a valid email address and check the delivery and order details." };
  const db = getDb();
  const input = canonicalOrder(parsed.data);
  await pilotCheckoutScope(db, input);
  if (input.items.some(item => item.offerId)) await expireInventoryReservations(new Date(), 20);
  await validateCheckoutCart(db, input, shopperId);
  const attemptId = randomUUID();
  const expiresAt = newQuoteExpiry();
  const quote = await calculateQuote(db, input, guestKey, attemptId, expiresAt);
  await db.checkoutAttempt.create({ data: {
    id: attemptId, guestKey, marketId, paymentMethod: input.paymentMethod, requestHash: requestDigest(JSON.stringify(input)),
    commerceEvidence: quote.commercial.evidence, commercialSnapshot: quote.commercial,
    quoteExpiresAt: expiresAt, reviewActor: checkoutReviewActor(shopperId), cartSource: input.cart?.source, cartRevision: input.cart?.revision,
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

export async function startPrepaid(raw: unknown, guestKey: string, direct: boolean, shopperId?: string | null,
  marketId: MarketId | undefined = providerMarket("SSLCOMMERZ")): Promise<PrepaidPaymentResult> {
  const config = prepaidConfig(marketId);
  if (!marketId || !config || !prepaidAvailable(marketId)) return unavailable;
  const parsed = prepaidSubmissionInput.safeParse(raw);
  if (!parsed.success || parsed.data.marketId !== marketId) return conflict;
  const input = canonicalOrder(parsed.data);
  const { attemptId, reviewToken } = parsed.data;
  const db = getDb();
  await pilotCheckoutScope(db, input);
  const phase = await db.$transaction(async tx => {
    // Limit each browser to one reservation. A repeat click resumes its existing attempt.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${guestKey}), 884)`;
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt || attempt.guestKey !== guestKey || !validateReviewActor(attempt, shopperId) || attempt.requestHash !== requestDigest(JSON.stringify(input)) || attempt.abandonedAt ||
        (attempt.marketId && attempt.marketId !== marketId) || (attempt.paymentMethod && attempt.paymentMethod !== "SSLCOMMERZ")) {
      return { result: conflict };
    }
    const session = await tx.prepaidCheckout.findUnique({ where: { attemptId } });
    const order = placedOrder(attempt);
    if (order) return { result: session ? { ...order, direct: session.direct } : conflict };
    if (session) {
      if (session.providerAccountKey !== config.accountKey) return { result: accountReview };
      if (session.state === "AWAITING_PAYMENT") return { resume: true } as const;
      return { result: pending };
    }
    if (attempt.marketId !== marketId || attempt.paymentMethod !== "SSLCOMMERZ") return { result: conflict };
    const another = await tx.prepaidCheckout.findFirst({
      where: { attempt: { guestKey, marketId }, state: { in: ["PREPARING", "AWAITING_PAYMENT"] } }, select: { attemptId: true },
    });
    if (another) return { result: { kind: "conflict", message: "Check the status of your earlier online payment before starting another." } as const };

    await validateCheckoutCart(tx, input, shopperId, true);
    await lockQuoteRows(tx, input);
    const { quote, renewed } = await repriceCheckoutReview(tx, input, guestKey, attempt);
    if (renewed || !equalDigest(quote.reviewToken, reviewToken)) return { result: { kind: "changed", quote } as const };
    const shops = await snapshotShops(tx, quote);
    await tx.checkoutAttempt.update({ where: { id: attemptId }, data: {
      marketId, paymentMethod: input.paymentMethod, commerceEvidence: quote.commercial.evidence, commercialSnapshot: quote.commercial,
    } });
    const stockAllocations = await reservePurchaseStock(tx, purchaseContext(input, attemptId, guestKey, attempt.requestHash), quote.lines);
    const providerId = `GB${randomBytes(13).toString("hex")}`;
    await tx.prepaidCheckout.create({
      data: {
        attemptId, providerId, checkout: input, quote, marketplaceShopIds: shops, stockAllocations, shopperId, direct,
        providerAccountKey: config.accountKey, expectedAmountMinor: quote.totalMinor,
        couponCode: quote.couponCode, expiresAt: new Date(Date.now() + openingTime),
      },
    });
    return { providerId, quote };
  });
  if ("result" in phase && phase.result) return phase.result;
  if ("resume" in phase && phase.resume) return recoverPrepaid(attemptId, guestKey, true, marketId, shopperId);

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

async function reconcilePrepaid(attemptId: string, validationHint?: string, callback = false): Promise<PrepaidPaymentResult> {
  const db = getDb();
  const session = await db.prepaidCheckout.findUnique({ where: { attemptId }, include: { attempt: { select: { marketId: true } } } });
  if (!session) return conflict;
  const marketId = session.attempt.marketId;
  const account = prepaidConfig(marketId ?? undefined);
  const bound = marketId && account && account.accountKey === session.providerAccountKey && session.expectedAmountMinor !== null;
  if (!bound && callback) throw new PrepaidCallbackIdentityError();

  // Close-out trims address and quote details. Keep only the payment identity and amount to record delayed evidence.
  const observed = bound && (session.state === "AWAITING_PAYMENT" || callback || (session.state === "CLOSED" &&
    !session.bankTransactionId && Date.now() - session.expiresAt.getTime() < 5 * 60 * 60 * 1000));
  const provider = observed ? await lookupPrepaidStatus(session.providerId, session.expectedAmountMinor!, validationHint) : null;
  if (provider?.kind === "inapplicable" && callback) throw new PrepaidCallbackIdentityError();
  const eventKey = provider?.kind === "paid" ? `validation:${provider.validationId}`
    : provider?.kind === "review" && provider.validationId ? `rejected-validation:${provider.validationId}` : undefined;
  const event = eventKey && bound ? await recordPaymentEvent(db, {
    provider: "SSLCOMMERZ", accountKey: account.accountKey, eventKey, marketId,
    attemptId, providerReference: provider?.kind === "paid" ? provider.bankTransactionId : session.providerId,
    eventType: provider?.kind === "paid" ? "PAYMENT_VERIFIED" : "PAYMENT_VALIDATION_REJECTED",
    evidenceHash: paymentEventDigest([session.providerId, eventKey, provider?.kind === "paid" && provider.bankTransactionId,
      session.expectedAmountMinor, "BDT"]),
    amountMinor: session.expectedAmountMinor, currency: "BDT",
  }) : undefined;

  return db.$transaction(async tx => {
    const attempt = await lockAttempt(tx, attemptId);
    const current = await tx.prepaidCheckout.findUnique({ where: { attemptId } });
    if (!attempt || !current) return conflict;
    const result = placedOrder(attempt);
    if (result) {
      if (event) await finishPaymentEvent(tx, event, provider?.kind === "paid" &&
        provider.bankTransactionId === current.bankTransactionId ? "PAID" : "REJECTED");
      return { ...result, direct: current.direct };
    }
    if (!bound) return accountReview;
    if (current.state === "CLOSED" || current.state === "PREPARING" && provider?.kind === "paid") {
      if (provider?.kind === "paid" && event) {
        if (current.state === "PREPARING") await closePrepaid(tx, current, marketId);
        if (current.bankTransactionId && current.bankTransactionId !== provider.bankTransactionId) {
          await finishPaymentEvent(tx, event, "REJECTED");
          return verificationReview;
        }
        if (!current.bankTransactionId) await tx.prepaidCheckout.update({
          where: { attemptId }, data: { bankTransactionId: provider.bankTransactionId },
        });
        await finishPaymentEvent(tx, event, "PAYMENT_EXCEPTION");
        return refundReview;
      }
      if (event) await finishPaymentEvent(tx, event, "REJECTED");
      const exception = await tx.inventoryReservation.findUnique({ where: { attemptId }, select: { state: true } });
      return current.bankTransactionId || exception?.state === "PAYMENT_EXCEPTION" ? refundReview : abandoned;
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
    if (provider.kind === "review" || provider.kind === "inapplicable") {
      if (event) await finishPaymentEvent(tx, event, "REJECTED");
      return verificationReview;
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
    if (event) await finishPaymentEvent(tx, event, order.kind === "placed" ? "PAID" : "PAYMENT_EXCEPTION");
    if (order.kind === "refund_required") return refundReview;
    return { ...order, direct: current.direct };
  });
}

export async function recoverPrepaid(attemptId: string, guestKey: string, resume = false,
  marketId: MarketId | undefined = providerMarket("SSLCOMMERZ"), shopperId?: string | null): Promise<PrepaidPaymentResult> {
  if (!marketId) return abandoned;
  const prepaid = await getDb().$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${guestKey}), 884)`;
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt || attempt.guestKey !== guestKey || !validateReviewActor(attempt, shopperId) || attempt.marketId !== marketId ||
        (attempt.paymentMethod && attempt.paymentMethod !== "SSLCOMMERZ")) return null;
    const session = await tx.prepaidCheckout.findUnique({ where: { attemptId } });
    if (!session && !attempt.order && !attempt.abandonedAt && attempt.paymentMethod === "SSLCOMMERZ") {
      // Seal the unused review before returning a terminal result to the buyer.
      await tx.checkoutAttempt.update({ where: { id: attemptId }, data: { abandonedAt: new Date() } });
    }
    return session;
  });
  if (!prepaid) return abandoned;
  const result = await reconcilePrepaid(attemptId);
  if (resume && result === pending && prepaid.state === "AWAITING_PAYMENT" && prepaid.expiresAt > new Date() && prepaid.redirectUrl) {
    if (scopedCatalogPilotRequested()) await pilotQuoteScope(getDb(), marketId, "SSLCOMMERZ", quoteSnapshot(prepaid).lines);
    return { kind: "continue", redirectUrl: prepaid.redirectUrl };
  }
  return result;
}

export async function acceptPrepaidCallback(providerId: string, validationHint?: string) {
  const session = await getDb().prepaidCheckout.findUnique({ where: { providerId }, select: { attemptId: true } });
  if (!session) return null;
  await reconcilePrepaid(session.attemptId, validationHint, true);
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
