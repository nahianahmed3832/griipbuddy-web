import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { orderIntakeOpen } from "../release-config.ts";
import type { MarketId } from "../../config/markets.ts";
import type { CheckoutFailure, OrderPlaced } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { equalDigest, requestDigest } from "./guest.ts";
import { createOrderParcels } from "./location-inventory.ts";
import { lockAttempt, lockVariantQuoteRows, placedOrder } from "./orders.ts";
import { checkoutOrderLine } from "./checkout-merchandise.ts";
import { legacyPurchaseStock, placeReservedPurchase, releasePurchaseStock, reservePurchaseStock } from "./checkout-inventory.ts";
import { expireInventoryReservations } from "./inventory-reservations.ts";
import { paypalCheckoutAvailability, paypalSandboxConfig } from "./paypal-config.ts";
import { commercialTerms, configuredPayment, providerMarket } from "./market-commerce.ts";
import {
  captureSandboxOrder, createSandboxOrder, inspectSandboxOrder, inspectSandboxRefund, PayPalProviderError, refundSandboxCapture, samePayPalAmount,
  type PayPalOrder,
} from "./paypal-provider.ts";
import {
  normalizedPayPalInput, paypalQuoteToken, paypalShippingAddress, quotePayPalCheckout, storedPayPalQuote,
  type PayPalCheckoutInput, type PayPalQuote,
} from "./paypal-quote.ts";

const approvalLifetimeMs = 30 * 60 * 1000;
const captureRetryLifetimeMs = 5 * 60 * 60 * 1000;
const paymentTransaction = { maxWait: 5_000, timeout: 45_000 };
const paypalCheckoutInclude = { attempt: { include: { order: { include: { items: true } } } } } as const;
type Session = Prisma.PayPalCheckoutGetPayload<{ include: typeof paypalCheckoutInclude }>;

type Pending = { kind: "pending"; attemptId: string; message: string };
type Abandoned = { kind: "abandoned"; attemptId: string; message: string };
type Approval = { kind: "approval_required"; attemptId: string; approvalUrl: string };
export type PayPalPaymentResult = OrderPlaced | Pending | Abandoned | Approval | CheckoutFailure;

function unavailable(message: string) {
  return { kind: "unavailable", message } as const;
}

function pending(attemptId: string): Pending {
  return { kind: "pending", attemptId, message: "PayPal hasn’t confirmed this payment yet. Check payment status before starting another order." };
}

function abandoned(attemptId: string, message = "This PayPal checkout has ended. You can return to your cart and try again."): Abandoned {
  return { kind: "abandoned", attemptId, message };
}

function sessionResult(session: Session): PayPalPaymentResult {
  const order = placedOrder(session.attempt);
  if (order) return order;
  if (session.state === "CANCELLED") return abandoned(session.attemptId);
  if (session.state === "APPROVAL" && session.approvalUrl) {
    return { kind: "approval_required", attemptId: session.attemptId, approvalUrl: session.approvalUrl };
  }
  return pending(session.attemptId);
}

export async function paypalQuote(raw: unknown, guestKey: string, marketId: MarketId | undefined = providerMarket("PAYPAL")) {
  if (!marketId || !paypalCheckoutAvailability(marketId).quoteEnabled) return unavailable("Test checkout is unavailable for this market.");
  const input = normalizedPayPalInput(raw);
  if (input.items.some(item => item.offerId)) await expireInventoryReservations(new Date(), 20);
  const quote = await quotePayPalCheckout(getDb(), input, marketId);
  return {
    kind: "quoted" as const,
    quote: {
      currency: quote.currency, shippingMinor: quote.shippingMinor, taxMinor: quote.taxMinor,
      deliveryLabel: quote.deliveryLabel, merchandiseSubtotalMinor: quote.merchandiseSubtotalMinor, totalMinor: quote.totalMinor,
      quoteToken: paypalQuoteToken(guestKey, input, quote, marketId),
      lines: quote.lines.map(line => ({
        name: line.productName, variantLabel: line.variantName, quantity: line.quantity, lineMinor: line.lineTotalMinor,
        ...(line.personalization && { personalization: line.personalization }),
      })),
    },
  };
}

async function lockPayPalSession(tx: Prisma.TransactionClient, attemptId: string) {
  await lockAttempt(tx, attemptId);
  await tx.$queryRaw`SELECT "attemptId" FROM "PayPalCheckout" WHERE "attemptId" = ${attemptId}::uuid FOR UPDATE`;
  return tx.payPalCheckout.findUnique({ where: { attemptId }, include: paypalCheckoutInclude });
}

function readSnapshot(session: Session) {
  return { input: normalizedPayPalInput(session.checkout), quote: storedPayPalQuote.parse(session.quote) };
}

function paypalPurchaseContext(session: Session, input: PayPalCheckoutInput, marketId: MarketId) {
  return { marketId, paymentMethod: "PAYPAL" as const, attemptId: session.attemptId,
    guestKey: session.attempt.guestKey, checkoutHash: session.attempt.requestHash, destination: {
      country: input.customer.country, district: input.customer.state.toLowerCase(), postalCode: input.customer.postalCode,
      method: "sandbox-standard",
    } };
}

async function cancelSession(tx: Prisma.TransactionClient, session: Session, reason?: string, decline = false): Promise<Abandoned> {
  if (session.state === "CAPTURING") {
    const { quote } = readSnapshot(session);
    const marketId = session.attempt.marketId ?? providerMarket("PAYPAL");
    if (!marketId) throw new Error("The PayPal reservation market is unavailable.");
    await releasePurchaseStock(tx, session.attemptId, marketId, "PAYPAL", legacyPurchaseStock(session.stockAllocations, quote.lines));
  }
  await tx.payPalCheckout.update({ where: { attemptId: session.attemptId }, data: {
    state: "CANCELLED", checkout: Prisma.DbNull, quote: Prisma.DbNull, stockAllocations: Prisma.DbNull, approvalUrl: null, shopperId: null,
    ...(decline && !session.providerFailedAt && { providerFailedAt: new Date(), providerFailureCode: "DECLINED" }),
  } });
  await tx.checkoutAttempt.update({
    where: { id: session.attemptId }, data: { abandonedAt: new Date() },
  });
  return abandoned(session.attemptId, reason);
}

async function provideApproval(attemptId: string, guestKey: string, marketId: MarketId): Promise<PayPalPaymentResult> {
  return getDb().$transaction(async tx => {
    const session = await lockPayPalSession(tx, attemptId);
    if (session?.attempt.guestKey !== guestKey || session.attempt.marketId !== marketId) return abandoned(attemptId);
    if (session.state !== "CREATING" && session.state !== "APPROVAL") return sessionResult(session);
    if (session.expiresAt <= new Date()) return cancelSession(tx, session);
    if (!paypalCheckoutAvailability(marketId).paymentEnabled) return unavailable("PayPal sandbox checkout is currently unavailable.");
    if (session.state === "APPROVAL") return sessionResult(session);
    const { input, quote } = readSnapshot(session);
    const provider = await createSandboxOrder({
      attemptId, shippingAddress: paypalShippingAddress(input.customer), name: input.customer.name,
      totalMinor: quote.totalMinor, shippingMinor: quote.shippingMinor, taxMinor: quote.taxMinor,
      merchandiseMinor: quote.merchandiseSubtotalMinor, lines: quote.lines,
    });
    await tx.payPalCheckout.update({ where: { attemptId }, data: { ...provider, state: "APPROVAL" } });
    return { kind: "approval_required", attemptId, approvalUrl: provider.approvalUrl };
  }, paymentTransaction);
}

export async function createPayPalCheckout(raw: unknown, attemptId: string, quoteToken: string, guestKey: string, shopperId?: string,
  marketId: MarketId | undefined = providerMarket("PAYPAL")): Promise<PayPalPaymentResult> {
  const operating = marketId && configuredPayment(marketId, "PAYPAL");
  if (!marketId || !operating || !paypalCheckoutAvailability(marketId).paymentEnabled) return unavailable("PayPal sandbox checkout is currently unavailable.");
  const input = normalizedPayPalInput(raw);
  const hash = requestDigest(JSON.stringify({ scope: "paypal-sandbox", marketId, input }));
  const created = await getDb().$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${attemptId}), 678)`;
    const known = await tx.checkoutAttempt.findUnique({ where: { id: attemptId }, include: { paypal: true } });
    if (known) {
      if (known.guestKey !== guestKey || known.marketId !== marketId || known.requestHash !== hash || !known.paypal) return false;
      if (known.paypal.quote && !equalDigest(paypalQuoteToken(guestKey, input, storedPayPalQuote.parse(known.paypal.quote), marketId), quoteToken)) return false;
      return true;
    }
    const quote = await quotePayPalCheckout(tx, input, marketId);
    if (!equalDigest(paypalQuoteToken(guestKey, input, quote, marketId), quoteToken)) return false;
    const snapshot = commercialTerms(operating, {
      deliveryService: "sandbox-standard", deliveryZone: input.customer.state.toLowerCase(),
      policyRevision: quote.policyRevision, taxBasisPoints: quote.taxBasisPoints,
    });
    await tx.checkoutAttempt.create({ data: {
      id: attemptId, guestKey, marketId, paymentMethod: "PAYPAL", commerceEvidence: snapshot.evidence, commercialSnapshot: snapshot,
      requestHash: hash, paypal: { create: {
        checkout: input, quote, shopperId, expiresAt: new Date(Date.now() + approvalLifetimeMs),
      } },
    } });
    return true;
  });
  if (!created) return { kind: "conflict", message: "Review the current market order total before going to PayPal." };
  return provideApproval(attemptId, guestKey, marketId);
}

function verifiedUnit(session: Session, input: PayPalCheckoutInput, quote: PayPalQuote, provider: PayPalOrder) {
  const unit = provider.purchase_units?.[0];
  if (provider.id !== session.providerOrderId || provider.purchase_units?.length !== 1 ||
      unit?.reference_id !== session.attemptId || !samePayPalAmount(unit.amount, quote.totalMinor)) return null;
  const approved = unit.shipping?.address;
  const expected = paypalShippingAddress(input.customer);
  const canonical = (value: string | undefined) => (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!approved || Object.entries(expected).some(([key, value]) =>
    canonical(approved[key as keyof typeof approved]) !== canonical(value)) ||
      canonical(approved.address_line_2) !== canonical(expected.address_line_2)) return null;
  return unit;
}

async function acceptCapture(tx: Prisma.TransactionClient, session: Session, provider: PayPalOrder): Promise<PayPalPaymentResult | null> {
  if (provider.id !== session.providerOrderId) throw new Error("Provider order did not match the payment session.");
  if (provider.status === "VOIDED") return cancelSession(tx, session, "PayPal voided this payment. Your card or balance hasn’t been charged.");
  const { input, quote } = readSnapshot(session);
  const unit = verifiedUnit(session, input, quote, provider);
  if (!unit) throw new Error("Provider amount or destination could not be verified.");
  const captures = unit.payments?.captures ?? [];
  if (captures.length === 1 && ["DECLINED", "DENIED", "FAILED"].includes(captures[0].status)) {
    return cancelSession(tx, session, "PayPal declined the payment. Review your cart and try again.", true);
  }
  const capture = captures[0];
  if (provider.status !== "COMPLETED" || captures.length !== 1 || capture.status !== "COMPLETED" ||
      !samePayPalAmount(capture.amount, quote.totalMinor)) return null;

  const customer = input.customer;
  const { marketId, commerceEvidence, commercialSnapshot } = session.attempt;
  if (!marketId || marketId !== providerMarket("PAYPAL") || commerceEvidence === "production") {
    throw new Error("PayPal captured outside the configured sandbox market.");
  }
  const shopper = session.shopperId
    ? await tx.shopper.findUnique({ where: { id: session.shopperId }, select: { id: true } })
    : null;
  const order = await placeReservedPurchase(tx, paypalPurchaseContext(session, input, marketId), quote.lines,
    legacyPurchaseStock(session.stockAllocations, quote.lines), async (sameTransaction, allocations) => {
    const saved = await sameTransaction.order.create({ data: {
    attemptId: session.attemptId, reference: `GB-${randomBytes(6).toString("hex").toUpperCase()}`, marketId, currency: quote.currency,
    measurementTest: true, commerceEvidence, commercialSnapshot: commercialSnapshot ?? Prisma.DbNull,
    shopperId: shopper?.id, customerName: customer.name, phone: customer.phone, email: customer.email,
    address: [customer.addressLine1, customer.addressLine2].filter(Boolean).join(", "), locality: customer.city,
    district: customer.state.toLowerCase(), districtLabel: customer.state, postalCode: customer.postalCode,
    deliveryMethod: "sandbox-standard", deliveryLabel: quote.deliveryLabel, deliveryGuidance: "Sandbox order · no physical shipment",
    taxLabel: quote.taxLabel ?? "Tax (test)", subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor,
    deliveryMinor: quote.shippingMinor, taxMinor: quote.taxMinor, totalMinor: quote.totalMinor,
    items: { create: quote.lines.map(line => ({ ...checkoutOrderLine(line), currency: quote.currency })) },
    payment: { create: { method: "PAYPAL", status: "PAID", amountMinor: quote.totalMinor, currency: quote.currency } },
    events: { create: { type: "ORDER_PLACED", status: "UNFULFILLED" } },
    }, select: { id: true } });
    await createOrderParcels(sameTransaction, saved.id, allocations);
    return { kind: "placed", orderId: saved.id, purchased: input.items };
  }, { reference: capture.id, currency: quote.currency, amountMinor: quote.totalMinor });
  if (order.kind === "refund_required") {
    if (order.newlyRecorded) await tx.payPalCheckout.update({ where: { attemptId: session.attemptId }, data: {
      captureId: capture.id, refundStartedAt: new Date(),
    } });
    return { ...pending(session.attemptId), message: "Payment arrived after the stock hold ended. Your cart is saved while PayPal reconciles the refund." };
  }
  await tx.payPalCheckout.update({ where: { attemptId: session.attemptId }, data: {
    state: "COMPLETED", captureId: capture.id, checkout: Prisma.DbNull, quote: Prisma.DbNull,
    stockAllocations: Prisma.DbNull, approvalUrl: null, shopperId: null,
  } });
  return order;
}

async function processCapture(attemptId: string, retry: boolean): Promise<PayPalPaymentResult> {
  const result = await getDb().$transaction(async tx => {
    const session = await lockPayPalSession(tx, attemptId);
    if (!session) return abandoned(attemptId);
    if (session.state !== "CAPTURING" || !session.providerOrderId) return sessionResult(session);
    const reservation = await tx.inventoryReservation.findUnique({ where: { attemptId }, select: { state: true, expiresAt: true } });
    if (reservation?.state === "PAYMENT_EXCEPTION") return pending(attemptId);
    const provider = await inspectSandboxOrder(session.providerOrderId);
    const known = await acceptCapture(tx, session, provider);
    if (known) return known;
    if (!retry || provider.status !== "APPROVED" || !session.captureStartedAt ||
        (reservation && (reservation.state !== "HELD" || reservation.expiresAt <= new Date())) ||
        Date.now() - session.captureStartedAt.getTime() >= captureRetryLifetimeMs) return pending(attemptId);

    try {
      // Capture can time out after PayPal has taken payment. Inspect its final state before restoring any units.
      await captureSandboxOrder(session.providerOrderId, attemptId);
    } catch (error) {
      if (!(error instanceof PayPalProviderError)) throw error;
      if (error.issue === "INSTRUMENT_DECLINED" || error.issue === "TRANSACTION_REFUSED") {
        const latest = await inspectSandboxOrder(session.providerOrderId);
        const result = await acceptCapture(tx, session, latest);
        if (result) return result;
        if (latest.status === "APPROVED" && !latest.purchase_units?.some(unit => unit.payments?.captures?.length)) {
          return cancelSession(tx, session, "PayPal declined the payment. Review your cart and try again.", true);
        }
        return pending(attemptId);
      }
      if (error.issue !== "ORDER_ALREADY_CAPTURED") throw error;
    }
    const latest = await inspectSandboxOrder(session.providerOrderId);
    return await acceptCapture(tx, session, latest) ?? pending(attemptId);
  }, paymentTransaction);
  if (result.kind === "pending") return await settlePayPalPurchaseException(attemptId, true) ?? result;
  return result;
}

async function settlePayPalPurchaseException(attemptId: string, allowRequest: boolean): Promise<PayPalPaymentResult | null> {
  return getDb().$transaction(async tx => {
    const session = await lockPayPalSession(tx, attemptId);
    if (!session?.captureId || !session.refundStartedAt || session.attempt.order) return null;
    const reservation = await tx.inventoryReservation.findUnique({ where: { attemptId } });
    if (reservation?.state !== "PAYMENT_EXCEPTION" || reservation.paymentReference !== session.captureId ||
        reservation.paymentCurrency !== "USD" || reservation.paymentAmountMinor === null) return null;
    if (session.state === "CANCELLED") return abandoned(attemptId, "PayPal refunded the late payment. Your cart is saved.");
    if (!session.refundId && (!allowRequest || Date.now() - session.refundStartedAt.getTime() >= captureRetryLifetimeMs)) {
      return { ...pending(attemptId), message: "A late PayPal capture needs refund reconciliation. Your cart is saved." };
    }
    const refund = session.refundId ? await inspectSandboxRefund(session.refundId)
      : await refundSandboxCapture(session.captureId, attemptId);
    if ((session.refundId && refund.id !== session.refundId) || !samePayPalAmount(refund.amount, reservation.paymentAmountMinor)) {
      throw new Error("PayPal late-payment refund does not match the verified capture.");
    }
    if (refund.status === "COMPLETED") {
      await tx.payPalCheckout.update({ where: { attemptId }, data: {
        state: "CANCELLED", refundId: refund.id, checkout: Prisma.DbNull, quote: Prisma.DbNull,
        stockAllocations: Prisma.DbNull, approvalUrl: null, shopperId: null,
      } });
      await tx.inventoryReservation.update({ where: { attemptId }, data: { exceptionReason: "LATE_PAYMENT_REFUNDED" } });
      return abandoned(attemptId, "PayPal refunded the late payment. Your cart is saved.");
    }
    if (!session.refundId) await tx.payPalCheckout.update({ where: { attemptId }, data: { refundId: refund.id } });
    return { ...pending(attemptId), message: "PayPal hasn’t confirmed the late-payment refund. Your cart is saved." };
  }, paymentTransaction);
}

export async function recoverPayPalCheckout(attemptId: string, guestKey: string, action: "capture" | "cancel" | "recover",
  marketId: MarketId | undefined = providerMarket("PAYPAL")): Promise<PayPalPaymentResult> {
  if (!marketId || marketId !== providerMarket("PAYPAL")) return abandoned(attemptId);
  const prepared = await getDb().$transaction(async tx => {
    // Also serialize with the initial create. A recover/cancel during a lost create response
    // prevents a still-in-flight request from opening a new payment after the shopper leaves.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${attemptId}), 678)`;
    const session = await lockPayPalSession(tx, attemptId);
    if (!session) {
      if (action !== "capture") await tx.checkoutAttempt.createMany({ data: {
        id: attemptId, guestKey, marketId, paymentMethod: "PAYPAL", requestHash: requestDigest("abandoned-paypal"), abandonedAt: new Date(),
      }, skipDuplicates: true });
      return { result: abandoned(attemptId) };
    }
    if (session.attempt.guestKey !== guestKey || session.attempt.marketId !== marketId) return { result: abandoned(attemptId) };

    if (session.state === "CAPTURING") return { capture: true };
    if (session.state === "CANCELLED" || session.state === "COMPLETED") return { result: sessionResult(session) };
    if (action === "cancel" || session.expiresAt <= new Date()) return { result: await cancelSession(tx, session) };
    if (session.state === "CREATING" || !session.providerOrderId) return { approval: true };
    if (action !== "capture") return { result: sessionResult(session) };
    if (!orderIntakeOpen() || !configuredPayment(marketId, "PAYPAL")) {
      return { result: await cancelSession(tx, session, "Order intake is paused. PayPal hasn’t charged this order.") };
    }
    const provider = await inspectSandboxOrder(session.providerOrderId);
    if (provider.status === "VOIDED") return { result: await cancelSession(tx, session) };
    if (provider.status !== "APPROVED") return { result: sessionResult(session) };

    const { input, quote } = readSnapshot(session);
    if (!verifiedUnit(session, input, quote, provider)) {
      return { result: await cancelSession(tx, session, "PayPal’s approved total or shipping address differs from checkout. Review your cart again.") };
    }
    await lockVariantQuoteRows(tx, marketId, quote.lines.map(line => line.variantId));
    await tx.$queryRaw`SELECT "marketId" FROM "CheckoutPolicy" WHERE "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
    try {
      const current = await quotePayPalCheckout(tx, input, marketId);
      if (paypalQuoteToken(guestKey, input, current, marketId) !== paypalQuoteToken(guestKey, input, quote, marketId)) {
        return { result: await cancelSession(tx, session, "Order details changed before payment. Review the updated cart before trying again.") };
      }
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
      return { result: await cancelSession(tx, session, error.detail.message) };
    }
    const stockAllocations = await reservePurchaseStock(tx, paypalPurchaseContext(session, input, marketId), quote.lines);
    await tx.payPalCheckout.update({ where: { attemptId }, data: { state: "CAPTURING", captureStartedAt: new Date(), stockAllocations } });
    return { capture: true };
  }, paymentTransaction);
  if (prepared.result) return prepared.result;
  if (prepared.approval) return provideApproval(attemptId, guestKey, marketId);
  return processCapture(attemptId, action === "capture" || action === "recover");
}

export async function reconcilePayPalCapture(providerOrderId: string) {
  const config = paypalSandboxConfig();
  if (!config) return;
  const session = await getDb().payPalCheckout.findUnique({
    where: { providerOrderId, attempt: { marketId: config.marketId } }, select: { attemptId: true, state: true },
  });
  if (session?.state === "CAPTURING") await processCapture(session.attemptId, false);
}

export async function reconcilePayPalPurchaseRefund(refundId: string) {
  const session = await getDb().payPalCheckout.findUnique({ where: { refundId }, select: { attemptId: true } });
  if (session) await settlePayPalPurchaseException(session.attemptId, false);
}
