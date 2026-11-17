import { randomBytes } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { variantQuantities } from "../cart/model.ts";
import { getDb } from "../db/client.ts";
import { hybridStoreMode, orderIntakeOpen } from "../release-config.ts";
import type { CheckoutFailure, OrderPlaced, QuoteLine } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { equalDigest, requestDigest } from "./guest.ts";
import { paypalCheckoutAvailability, paypalSandboxConfig } from "./paypal-config.ts";
import { notifyOrder } from "./order-notifications.ts";
import { returnTermsForCheckout } from "./order-return-terms.ts";
import {
  captureSandboxOrder, createSandboxOrder, inspectSandboxOrder, PayPalProviderError, samePayPalAmount,
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
  if (session.attempt.order) {
    return {
      kind: "placed", orderId: session.attempt.order.id,
      purchased: session.attempt.order.items.map(({ variantId, quantity, personalization }) =>
        ({ variantId, quantity, ...(personalization && { personalization }) })),
    };
  }
  if (session.state === "CANCELLED") return abandoned(session.attemptId);
  if (session.state === "APPROVAL" && session.approvalUrl) {
    return { kind: "approval_required", attemptId: session.attemptId, approvalUrl: session.approvalUrl };
  }
  return pending(session.attemptId);
}

export async function paypalQuote(raw: unknown, guestKey: string) {
  if (!paypalCheckoutAvailability().quoteEnabled) return unavailable("US test checkout is unavailable.");
  const input = normalizedPayPalInput(raw);
  const quote = await quotePayPalCheckout(getDb(), input);
  return {
    kind: "quoted" as const,
    quote: {
      currency: quote.currency, shippingMinor: quote.shippingMinor, taxMinor: quote.taxMinor,
      subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor,
      deliveryLabel: quote.deliveryLabel, merchandiseSubtotalMinor: quote.merchandiseSubtotalMinor, totalMinor: quote.totalMinor,
      quoteToken: paypalQuoteToken(guestKey, input, quote),
      lines: quote.lines.map(line => ({
        name: line.productName, variantLabel: line.variantName, quantity: line.quantity, lineMinor: line.lineTotalMinor,
        ...(line.personalization && { personalization: line.personalization }),
      })),
    },
  };
}

async function lockPayPalSession(tx: Prisma.TransactionClient, attemptId: string) {
  await tx.$queryRaw`SELECT "attemptId" FROM "PayPalCheckout" WHERE "attemptId" = ${attemptId}::uuid FOR UPDATE`;
  return tx.payPalCheckout.findUnique({ where: { attemptId }, include: paypalCheckoutInclude });
}

function readSnapshot(session: Session) {
  return { input: normalizedPayPalInput(session.checkout), quote: storedPayPalQuote.parse(session.quote) };
}

async function cancelSession(tx: Prisma.TransactionClient, session: Session, reason?: string): Promise<Abandoned> {
  if (session.state === "CAPTURING") {
    const { quote } = readSnapshot(session);
    await changePayPalInventory(tx, quote.lines, false);
  }
  await tx.payPalCheckout.update({ where: { attemptId: session.attemptId }, data: {
    state: "CANCELLED", checkout: Prisma.DbNull, quote: Prisma.DbNull, approvalUrl: null, shopperId: null,
  } });
  await tx.checkoutAttempt.update({
    where: { id: session.attemptId }, data: { abandonedAt: new Date() },
  });
  return abandoned(session.attemptId, reason);
}

async function provideApproval(attemptId: string, guestKey: string): Promise<PayPalPaymentResult> {
  return getDb().$transaction(async tx => {
    const session = await lockPayPalSession(tx, attemptId);
    if (session?.attempt.guestKey !== guestKey) return abandoned(attemptId);
    if (session.state !== "CREATING" && session.state !== "APPROVAL") return sessionResult(session);
    if (session.expiresAt <= new Date()) return cancelSession(tx, session);
    if (!paypalCheckoutAvailability().paymentEnabled) return unavailable("PayPal sandbox checkout is currently unavailable.");
    if (session.state === "APPROVAL") return sessionResult(session);
    const { input, quote } = readSnapshot(session);
    const provider = await createSandboxOrder({
      attemptId, shippingAddress: paypalShippingAddress(input.customer), name: input.customer.name,
      totalMinor: quote.totalMinor, shippingMinor: quote.shippingMinor, merchandiseMinor: quote.merchandiseSubtotalMinor, lines: quote.lines,
    });
    await tx.payPalCheckout.update({ where: { attemptId }, data: { ...provider, state: "APPROVAL" } });
    return { kind: "approval_required", attemptId, approvalUrl: provider.approvalUrl };
  }, paymentTransaction);
}

export async function createPayPalCheckout(raw: unknown, attemptId: string, quoteToken: string, guestKey: string, shopperId?: string): Promise<PayPalPaymentResult> {
  if (!paypalCheckoutAvailability().paymentEnabled) return unavailable("PayPal sandbox checkout is currently unavailable.");
  const input = normalizedPayPalInput(raw);
  const hash = requestDigest(JSON.stringify({ scope: "paypal-us-test", input }));
  const created = await getDb().$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${attemptId}), 678)`;
    const known = await tx.checkoutAttempt.findUnique({ where: { id: attemptId }, include: { paypal: true } });
    if (known) {
      if (known.guestKey !== guestKey || known.requestHash !== hash || !known.paypal) return false;
      if (known.paypal.quote && !equalDigest(paypalQuoteToken(guestKey, input, storedPayPalQuote.parse(known.paypal.quote)), quoteToken)) return false;
      return true;
    }
    const quote = await quotePayPalCheckout(tx, input);
    if (!equalDigest(paypalQuoteToken(guestKey, input, quote), quoteToken)) return false;
    await tx.checkoutAttempt.create({ data: {
      id: attemptId, guestKey, requestHash: hash, paypal: { create: {
        checkout: input, quote, shopperId, expiresAt: new Date(Date.now() + approvalLifetimeMs),
      } },
    } });
    return true;
  });
  if (!created) return { kind: "conflict", message: "Review the current US order total before going to PayPal." };
  return provideApproval(attemptId, guestKey);
}

export async function changePayPalInventory(tx: Prisma.TransactionClient, lines: Pick<QuoteLine, "variantId" | "quantity">[], reserve: boolean) {
  const ordered = [...variantQuantities(lines)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [variantId, quantity] of ordered) {
    const result = await tx.inventory.updateMany({
      where: { variantId, ...(reserve && { available: { gte: quantity } }) },
      data: { available: reserve ? { decrement: quantity } : { increment: quantity } },
    });
    if (result.count !== 1) throw new CommerceError({
      kind: "unavailable", message: "Stock changed while you were checking out. Review the latest quantities in your cart.",
    });
  }
}

async function lockCatalog(tx: Prisma.TransactionClient, lines: QuoteLine[]) {
  const ids = Prisma.join([...new Set(lines.map(line => line.variantId))]);
  // Use the same inventory-then-offer locking order as COD checkout and staff workflows.
  await tx.$queryRaw`SELECT "variantId" FROM "Inventory" WHERE "variantId" IN (${ids}) ORDER BY "variantId" COLLATE "C" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT "variantId" FROM "MarketOffer" WHERE "marketId" = 'us' AND "variantId" IN (${ids})
    ORDER BY "variantId" COLLATE "C" FOR SHARE
  `;
  await tx.$queryRaw`
    SELECT v."id" FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
    WHERE v."id" IN (${ids}) ORDER BY v."id" FOR SHARE OF v, p
  `;
  if (hybridStoreMode()) await tx.$queryRaw`
    SELECT s."id" FROM "MarketplaceShop" s
    WHERE s."id" IN (SELECT p."marketplaceShopId" FROM "Product" p JOIN "Variant" v ON p."id" = v."productId"
      WHERE v."id" IN (${ids}))
    ORDER BY s."id" FOR SHARE
  `;
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
    return cancelSession(tx, session, "PayPal declined the payment. Review your cart and try again.");
  }
  const capture = captures[0];
  if (provider.status !== "COMPLETED" || captures.length !== 1 || capture.status !== "COMPLETED" ||
      !samePayPalAmount(capture.amount, quote.totalMinor)) return null;

  const customer = input.customer;
  const shopper = session.shopperId
    ? await tx.shopper.findUnique({ where: { id: session.shopperId }, select: { id: true } })
    : null;
  const order = await tx.order.create({ data: {
    attemptId: session.attemptId, reference: `GB-${randomBytes(6).toString("hex").toUpperCase()}`, marketId: "us", currency: "USD",
    measurementTest: true, shopperId: shopper?.id, customerName: customer.name, phone: customer.phone, email: customer.email,
    returnTerms: returnTermsForCheckout("us"),
    address: [customer.addressLine1, customer.addressLine2].filter(Boolean).join(", "), locality: customer.city,
    district: customer.state.toLowerCase(), districtLabel: customer.state, postalCode: customer.postalCode,
    deliveryMethod: "test-standard-us", deliveryLabel: quote.deliveryLabel, deliveryGuidance: "Sandbox order · no physical shipment",
    taxLabel: "Tax (test)", subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor,
    deliveryMinor: quote.shippingMinor, taxMinor: quote.taxMinor, totalMinor: quote.totalMinor,
    items: { create: quote.lines.map(line => ({ ...line, currency: "USD" })) },
    payment: { create: { method: "PAYPAL", status: "PAID", amountMinor: quote.totalMinor, currency: "USD" } },
    events: { create: { type: "ORDER_PLACED", status: "UNFULFILLED" } },
  }, select: { id: true } });
  await tx.payPalCheckout.update({ where: { attemptId: session.attemptId }, data: {
    state: "COMPLETED", captureId: capture.id, checkout: Prisma.DbNull, quote: Prisma.DbNull, approvalUrl: null, shopperId: null,
  } });
  return { kind: "placed", orderId: order.id, purchased: input.items };
}

async function processCapture(attemptId: string, retry: boolean): Promise<PayPalPaymentResult> {
  let mayCreateOrder = false;
  const outcome = await getDb().$transaction(async (tx): Promise<PayPalPaymentResult> => {
    const session = await lockPayPalSession(tx, attemptId);
    if (!session) return abandoned(attemptId);
    if (session.state !== "CAPTURING" || !session.providerOrderId) return sessionResult(session);
    // Only the locked CAPTURING branch can create an order. An already completed session returns above.
    mayCreateOrder = true;
    const provider = await inspectSandboxOrder(session.providerOrderId);
    const known = await acceptCapture(tx, session, provider);
    if (known) return known;
    if (!retry || provider.status !== "APPROVED" || !session.captureStartedAt ||
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
          return cancelSession(tx, session, "PayPal declined the payment. Review your cart and try again.");
        }
        return pending(attemptId);
      }
      if (error.issue !== "ORDER_ALREADY_CAPTURED") throw error;
    }
    const latest = await inspectSandboxOrder(session.providerOrderId);
    return await acceptCapture(tx, session, latest) ?? pending(attemptId);
  }, paymentTransaction);
  if (mayCreateOrder && outcome.kind === "placed") await notifyOrder(outcome.orderId, "received");
  return outcome;
}

export async function recoverPayPalCheckout(attemptId: string, guestKey: string, action: "capture" | "cancel" | "recover"): Promise<PayPalPaymentResult> {
  const prepared = await getDb().$transaction(async tx => {
    // Also serialize with the initial create. A recover/cancel during a lost create response
    // prevents a still-in-flight request from opening a new payment after the shopper leaves.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${attemptId}), 678)`;
    const session = await lockPayPalSession(tx, attemptId);
    if (!session) {
      if (action !== "capture") await tx.checkoutAttempt.createMany({ data: {
        id: attemptId, guestKey, requestHash: requestDigest("abandoned-paypal"), abandonedAt: new Date(),
      }, skipDuplicates: true });
      return { result: abandoned(attemptId) };
    }
    if (session.attempt.guestKey !== guestKey) return { result: abandoned(attemptId) };

    if (session.state === "CAPTURING") return { capture: true };
    if (session.state === "CANCELLED" || session.state === "COMPLETED") return { result: sessionResult(session) };
    if (action === "cancel" || session.expiresAt <= new Date()) return { result: await cancelSession(tx, session) };
    if (session.state === "CREATING" || !session.providerOrderId) return { approval: true };
    if (action !== "capture") return { result: sessionResult(session) };
    if (!orderIntakeOpen()) return { result: await cancelSession(tx, session, "Order intake is paused. PayPal hasn’t charged this order.") };
    const provider = await inspectSandboxOrder(session.providerOrderId);
    if (provider.status === "VOIDED") return { result: await cancelSession(tx, session) };
    if (provider.status !== "APPROVED") return { result: sessionResult(session) };

    const { input, quote } = readSnapshot(session);
    if (!verifiedUnit(session, input, quote, provider)) {
      return { result: await cancelSession(tx, session, "PayPal’s approved total or shipping address differs from checkout. Review your cart again.") };
    }
    await lockCatalog(tx, quote.lines);
    try {
      const current = await quotePayPalCheckout(tx, input);
      if (paypalQuoteToken(guestKey, input, current) !== paypalQuoteToken(guestKey, input, quote)) {
        return { result: await cancelSession(tx, session, "Order details changed before payment. Review the updated cart before trying again.") };
      }
    } catch (error) {
      if (!(error instanceof CommerceError)) throw error;
      return { result: await cancelSession(tx, session, error.detail.message) };
    }
    await changePayPalInventory(tx, quote.lines, true);
    await tx.payPalCheckout.update({ where: { attemptId }, data: { state: "CAPTURING", captureStartedAt: new Date() } });
    return { capture: true };
  }, paymentTransaction);
  if (prepared.result) return prepared.result;
  if (prepared.approval) return provideApproval(attemptId, guestKey);
  return processCapture(attemptId, action === "capture" || action === "recover");
}

export async function reconcilePayPalCapture(providerOrderId: string) {
  if (!paypalSandboxConfig()) return;
  const session = await getDb().payPalCheckout.findUnique({ where: { providerOrderId }, select: { attemptId: true, state: true } });
  if (session?.state === "CAPTURING") await processCapture(session.attemptId, false);
}
