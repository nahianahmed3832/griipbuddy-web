import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isOperatingDatabase } from "../db/local.ts";
import { hybridDemoMode, marketplaceMode, orderIntakeOpen } from "../release-config.ts";
import { marketConfiguration } from "../market-config.ts";
import { storeShop } from "../marketplace/constants.ts";
import { checkoutCoupon } from "../marketplace/coupons.ts";
import { applyCoupon } from "../marketplace/coupon-input.ts";
import { compareCartItems } from "../cart/model.ts";
import {
  checkoutInput, submissionInput, uuid, type CheckoutQuote, type DeliveryChoice,
  type NormalizedCheckout, type NormalizedPrepaidCheckout, type OrderPlaced, type RecoverResult, type ReviewResult, type SubmitResult,
} from "./checkout-types.ts";
import { checkoutReviewActor, validateCheckoutCart, validateReviewActor } from "./checkout-provenance.ts";
import { checkoutClosed, CommerceError } from "./errors.ts";
import { integratedCheckout, recoveredDeliveryChoices } from "./integrated-checkout.ts";
import { equalDigest, quoteDigest, requestDigest } from "./guest.ts";
import { prepaidAvailable } from "./prepaid-config.ts";
import { paypalCheckoutAvailability } from "./paypal-config.ts";
import { addressMatchesAdapter, fixtureAddress } from "./address.ts";
import { commercialTerms, configuredPayment, roundedMerchandiseTax, type CommercialTerms } from "./market-commerce.ts";
import { bangladeshCheckoutEnabled, usesBangladeshCheckout } from "./bangladesh-handoff.ts";
import { bangladeshTrackingHistory, bangladeshTrackingSummary } from "./bangladesh-shipment.ts";
import { createOrderParcels, lockDispatchLocations, lockVariantInventory, type StockAllocation } from "./location-inventory.ts";
import { shopperParcelHistory, shopperParcelSummary } from "./parcel-tracking.ts";
import { allocateCheckoutLines, quoteMerchandise } from "./checkout-merchandise.ts";
import { placeReservedPurchase, purchaseContext, reservePurchaseStock } from "./checkout-inventory.ts";
import { expireInventoryReservations } from "./inventory-reservations.ts";
import { pilotCheckoutScope } from "./scoped-pilot-checkout.ts";

const sqlIntMax = 2_147_483_647;
const quoteLifetimeMs = 20 * 60 * 1000;
type NativeCheckout = NormalizedCheckout | NormalizedPrepaidCheckout;
type NativePayment = NativeCheckout["paymentMethod"];
export { checkoutReviewActor, validateCheckoutCart, validateReviewActor } from "./checkout-provenance.ts";

export function newQuoteExpiry() {
  return new Date(Date.now() + quoteLifetimeMs);
}

function checkoutOperating(marketId: MarketId, payment: NativePayment) {
  if (usesBangladeshCheckout(marketId)) return null;
  return configuredPayment(marketId, payment);
}

async function getPolicy(db: DbReader, marketId: MarketId, payment: NativePayment) {
  const operating = checkoutOperating(marketId, payment);
  if (!operating || !orderIntakeOpen() || operating.market.pricing.taxTreatment !== "MERCHANDISE_RATE") return null;
  const { market } = operating;
  const policy = await db.checkoutPolicy.findUnique({ where: { marketId } });
  if (!policy?.enabled || (payment === "COD" ? !policy.codEnabled : !prepaidAvailable(marketId)) ||
      policy.countryCode !== market.countryCode || policy.currency !== market.currency ||
      policy.taxTreatment !== market.pricing.taxTreatment || policy.taxBasisPoints === null ||
      policy.taxBasisPoints < 0 || policy.taxBasisPoints > 10_000 || !policy.taxLabel?.trim()) return null;
  return { ...policy, taxBasisPoints: policy.taxBasisPoints, taxLabel: policy.taxLabel, operating };
}

export async function deliveryChoices(marketId: MarketId, payment: NativePayment = "COD", transaction?: DbReader): Promise<DeliveryChoice[]> {
  if (integratedCheckout(marketId)) return payment === "COD" && !transaction ? recoveredDeliveryChoices(marketId) : [];
  const db = transaction ?? getDb();
  if (!await getPolicy(db, marketId, payment)) return [];
  const rows = await db.deliveryZone.findMany({
    where: { marketId, enabled: true, ...(payment === "COD" && { codEligible: true }), chargeMinor: { not: null } },
    orderBy: [{ districtLabel: "asc" }, { label: "asc" }],
  });
  return rows.flatMap(({ district, districtLabel, method, label, chargeMinor, guidance }) =>
    chargeMinor === null ? [] : [{ district, districtLabel, method, label, chargeMinor, guidance }],
  );
}

export async function marketHasDelivery(marketId: MarketId, transaction?: DbReader) {
  if (bangladeshCheckoutEnabled(marketId) || paypalCheckoutAvailability(marketId).quoteEnabled) return true;
  if ((await deliveryChoices(marketId, "COD", transaction)).length) return true;
  return (await deliveryChoices(marketId, "SSLCOMMERZ", transaction)).length > 0;
}

export function canonicalOrder(input: NormalizedPrepaidCheckout): NormalizedPrepaidCheckout;
export function canonicalOrder(input: NormalizedCheckout): NormalizedCheckout;
export function canonicalOrder(input: NativeCheckout): NativeCheckout {
  const customer = hybridDemoMode() ? fixtureAddress(marketConfiguration(input.marketId).address.adapter, input.customer) : input.customer;
  return {
    marketId: input.marketId,
    items: [...input.items].sort(compareCartItems),
    customer,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    ...(input.cart && { cart: input.cart }),
    gift: marketplaceMode() ? input.gift : undefined,
    ...(marketplaceMode() && input.couponCode && { couponCode: input.couponCode }),
  } as NativeCheckout;
}

export async function calculateQuote(db: DbReader, input: NativeCheckout, guestKey: string,
  attemptId: string, expiresAt?: Date): Promise<CheckoutQuote & { commercial: CommercialTerms }> {
  const policy = await getPolicy(db, input.marketId, input.paymentMethod);
  if (!policy) throw new CommerceError({ kind: "unavailable", message: checkoutClosed });
  const { market } = policy.operating;
  if (!addressMatchesAdapter(market.address.adapter, market.countryCode, input.customer)) {
    throw new CommerceError({ kind: "invalid", message: "Use a delivery address supported by this checkout market." });
  }

  const zone = await db.deliveryZone.findUnique({
    where: { marketId_district_method: { marketId: input.marketId, district: input.customer.district, method: input.deliveryMethod } },
  });
  if (!zone?.enabled || (input.paymentMethod === "COD" && !zone.codEligible) || zone.chargeMinor === null || zone.chargeMinor < 0) {
    throw new CommerceError({ kind: "unavailable", message: "This delivery option is unavailable for the selected district. Choose another supported destination or delivery option." });
  }

  const merchandise = await quoteMerchandise(db, {
    marketId: input.marketId, paymentMethod: input.paymentMethod, items: input.items, destination: {
      country: input.customer.country ?? market.countryCode, district: input.customer.district,
      postalCode: input.customer.postalCode, method: input.deliveryMethod,
    },
  });

  const subtotalMinor = merchandise.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
  if (subtotalMinor > sqlIntMax) {
    throw new CommerceError({ kind: "invalid", message: "This cart exceeds the checkout limit. Please split it into smaller orders." });
  }
  const coupon = input.couponCode ? await checkoutCoupon(db, input.marketId, input.couponCode,
    merchandise.map(line => ({ shopId: line.marketplaceShopId ?? storeShop.id, netMinor: line.lineTotalMinor }))) : null;
  const withCoupon = coupon ? merchandise.map((line, index) => ({
    ...line,
    couponDiscountMinor: coupon.discounts[index],
    lineTotalMinor: line.lineTotalMinor - coupon.discounts[index],
  })) : merchandise;
  const prepaid = input.paymentMethod === "SSLCOMMERZ" ? applyCoupon(
    { kind: "PERCENT", value: 500, minimumMinor: 0, shopId: null },
    withCoupon.map(line => ({ shopId: storeShop.id, netMinor: line.lineTotalMinor })),
  ) : null;
  const lines = prepaid ? withCoupon.map((line, index) => ({
    ...line, prepaidDiscountMinor: prepaid.discounts[index], lineTotalMinor: line.lineTotalMinor - prepaid.discounts[index],
  })) : withCoupon;
  const discountMinor = merchandise.reduce((total, line) => total + line.unitDiscountMinor * line.quantity, 0) +
    (coupon?.total ?? 0) + (prepaid?.total ?? 0);
  const taxMinor = roundedMerchandiseTax(subtotalMinor - discountMinor, policy.taxBasisPoints);
  const totalMinor = subtotalMinor - discountMinor + zone.chargeMinor + taxMinor;
  if (input.paymentMethod === "SSLCOMMERZ" && (totalMinor < 1000 || totalMinor > 50_000_000)) {
    throw new CommerceError({ kind: "unavailable", message: "Online payment is available for order totals from ৳10 to ৳500,000." });
  }
  if (coupon && totalMinor === 0) {
    throw new CommerceError({ kind: "unavailable", message: "This coupon leaves no amount due for cash on delivery. Remove it or use another code." });
  }
  if (totalMinor > sqlIntMax) {
    throw new CommerceError({ kind: "invalid", message: "This cart exceeds the checkout limit. Please split it into smaller orders." });
  }

  const quote = {
    currency: policy.currency, lines, districtLabel: zone.districtLabel, deliveryLabel: zone.label, deliveryGuidance: zone.guidance,
    subtotalMinor, discountMinor, deliveryMinor: zone.chargeMinor, taxMinor, taxLabel: policy.taxLabel, totalMinor,
    ...(expiresAt && { expiresAt: expiresAt.toISOString() }),
    ...(coupon && { couponCode: input.couponCode, couponDiscountMinor: coupon.total }),
    ...(prepaid && { prepaidDiscountMinor: prepaid.total }),
  };
  const commercial = commercialTerms(policy.operating, { deliveryService: zone.method, deliveryZone: zone.district,
    deliveryRevision: zone.revision, policyRevision: policy.revision, taxBasisPoints: policy.taxBasisPoints });
  return { ...quote, commercial, reviewToken: quoteDigest(JSON.stringify({ guestKey, attemptId, input, quote, commercial })) };
}

export async function repriceCheckoutReview(tx: Prisma.TransactionClient, input: NativeCheckout, guestKey: string,
  attempt: { id: string; quoteExpiresAt: Date | null }) {
  const currentExpiry = attempt.quoteExpiresAt && attempt.quoteExpiresAt.getTime() > Date.now() ? attempt.quoteExpiresAt : null;
  const expiresAt = currentExpiry ?? newQuoteExpiry();
  const quote = await calculateQuote(tx, input, guestKey, attempt.id, expiresAt);
  if (!currentExpiry) await tx.checkoutAttempt.update({ where: { id: attempt.id }, data: { quoteExpiresAt: expiresAt } });
  return { quote, renewed: !currentExpiry };
}

export async function reviewCheckout(raw: unknown, marketId: MarketId, guestKey: string, shopperId?: string | null): Promise<ReviewResult> {
  if (!checkoutOperating(marketId, "COD") || !orderIntakeOpen()) return { kind: "unavailable", message: checkoutClosed };
  const parsed = checkoutInput.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", message: "Check your contact details, delivery address, and cart quantities." };
  if (parsed.data.marketId !== marketId) return { kind: "invalid", message: "Your shopping region changed. Return to the cart before reviewing again." };
  try {
    const db = getDb();
    const input = canonicalOrder(parsed.data);
    await validateCheckoutCart(db, input, shopperId);
    const pilot = await pilotCheckoutScope(db, input);
    if (!pilot && input.items.some(item => item.offerId)) await expireInventoryReservations(new Date(), 20);
    const attemptId = randomUUID();
    const expiresAt = newQuoteExpiry();
    const quote = await calculateQuote(db, input, guestKey, attemptId, expiresAt);
    await db.checkoutAttempt.create({ data: {
      id: attemptId, guestKey, requestHash: requestDigest(JSON.stringify(input)), marketId, paymentMethod: input.paymentMethod,
      quoteExpiresAt: expiresAt, reviewActor: checkoutReviewActor(shopperId), cartSource: input.cart?.source, cartRevision: input.cart?.revision,
      commerceEvidence: quote.commercial.evidence, commercialSnapshot: quote.commercial,
    } });
    return { kind: "review", attemptId, quote };
  } catch (error) {
    if (error instanceof CommerceError) return error.detail;
    throw error;
  }
}

type AttemptWithOrder = Prisma.CheckoutAttemptGetPayload<{ include: { order: { include: { items: true } } } }>;
type PlacedOrderLines = NonNullable<AttemptWithOrder["order"]>;

function savedOrderPurchase(order: PlacedOrderLines): OrderPlaced {
  return {
    kind: "placed", orderId: order.id,
    purchased: order.items.map(({ variantId, quantity, personalization, offerIdSnapshot, cartOfferIdSnapshot, cartVariantIdSnapshot }) => ({
      variantId, quantity, ...(personalization && { personalization }),
      ...(offerIdSnapshot && { offerId: offerIdSnapshot }), ...(cartOfferIdSnapshot && { cartOfferId: cartOfferIdSnapshot }),
      ...(cartVariantIdSnapshot && { cartVariantId: cartVariantIdSnapshot }),
    })).sort(compareCartItems),
  };
}

export function placedOrder(attempt: AttemptWithOrder): OrderPlaced | null {
  return attempt.order && savedOrderPurchase(attempt.order);
}

function attemptConflict() {
  return { kind: "conflict", message: "This checkout attempt cannot be reused. Check your recent order or start a new review." } as const;
}

export async function lockAttempt(tx: Prisma.TransactionClient, attemptId: string) {
  // Lock the review's unique row to serialize concurrent retries for this attempt.
  await tx.$queryRaw`SELECT "id" FROM "CheckoutAttempt" WHERE "id" = ${attemptId}::uuid FOR UPDATE`;
  return tx.checkoutAttempt.findUnique({ where: { id: attemptId }, include: { order: { include: { items: true } } } });
}

export async function lockVariantQuoteRows(tx: Prisma.TransactionClient, marketId: MarketId, variantIds: readonly string[]) {
  if (!variantIds.length) return;
  const variants = Prisma.join([...new Set(variantIds)]);
  // Lock in a stable order. Staff price edits lock only the offer; stock edits lock only inventory.
  await lockVariantInventory(tx, variantIds);
  await tx.$queryRaw`
    SELECT "variantId" FROM "MarketOffer"
    WHERE "marketId" = ${marketId}::"MarketCode" AND "variantId" IN (${variants})
    ORDER BY "variantId" COLLATE "C" FOR SHARE
  `;
  await tx.$queryRaw`
    SELECT v."id" FROM "Variant" v JOIN "Product" p ON p."id" = v."productId"
    WHERE v."id" IN (${variants}) ORDER BY v."id" FOR SHARE OF v, p
  `;
  if (marketplaceMode()) await tx.$queryRaw`
    SELECT s."id" FROM "MarketplaceShop" s
    WHERE s."id" IN (SELECT p."marketplaceShopId" FROM "Product" p JOIN "Variant" v ON p."id" = v."productId"
      WHERE v."id" IN (${variants})) ORDER BY s."id" FOR SHARE
  `;
  await lockDispatchLocations(tx, variantIds);
}

export async function lockQuoteRows(tx: Prisma.TransactionClient, input: NativeCheckout) {
  await lockVariantQuoteRows(tx, input.marketId, input.items.map(({ variantId }) => variantId));
  await tx.$queryRaw`SELECT "marketId" FROM "CheckoutPolicy" WHERE "marketId" = ${input.marketId}::"MarketCode" FOR SHARE`;
  await tx.$queryRaw`
    SELECT "district" FROM "DeliveryZone" WHERE "marketId" = ${input.marketId}::"MarketCode"
    AND "district" = ${input.customer.district} AND "method" = ${input.deliveryMethod} FOR SHARE
  `;
  // Serialize use-limit checks across shoppers redeeming the same coupon.
  if (input.couponCode) await tx.$queryRaw`SELECT "code" FROM "MarketplaceCoupon" WHERE "code" = ${input.couponCode} FOR UPDATE`;
}

export async function snapshotShops(tx: Prisma.TransactionClient, quote: CheckoutQuote): Promise<Record<string, string | null>> {
  if (!marketplaceMode()) return {};
  const rows = await tx.variant.findMany({
    where: { id: { in: quote.lines.map(line => line.variantId) } },
    select: { id: true, product: { select: { marketplaceShopId: true } } },
  });
  return Object.fromEntries(rows.map(row => [row.id, row.product.marketplaceShopId]));
}

export async function createNativeOrder(tx: Prisma.TransactionClient, input: NativeCheckout,
  quote: CheckoutQuote & { commercial?: CommercialTerms },
  attemptId: string, shops: Record<string, string | null>, allocations: readonly StockAllocation[], shopperId?: string,
  staffActivity = false): Promise<OrderPlaced> {
  const { name, phone, email, district, locality, address, postalCode } = input.customer;
  const commercialSnapshot = quote.commercial && { ...quote.commercial, evidence: staffActivity ? "fixture" as const : quote.commercial.evidence };
  const commerceEvidence = commercialSnapshot?.evidence;
  if (commercialSnapshot) await tx.checkoutAttempt.update({
    where: { id: attemptId },
    data: { marketId: input.marketId, paymentMethod: input.paymentMethod, commerceEvidence, commercialSnapshot },
  });
  const order = await tx.order.create({
    data: {
      attemptId, reference: `GB-${randomBytes(6).toString("hex").toUpperCase()}`, marketId: input.marketId, currency: quote.currency,
      measurementTest: commerceEvidence !== "production",
      commerceEvidence,
      commercialSnapshot,
      ...(marketplaceMode() && { shopperId, gift: Boolean(input.gift), giftNote: input.gift?.note || null }),
      customerName: name, phone, email, district, districtLabel: quote.districtLabel, locality, address, postalCode,
      deliveryMethod: input.deliveryMethod, deliveryLabel: quote.deliveryLabel, deliveryGuidance: quote.deliveryGuidance, taxLabel: quote.taxLabel,
      subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor,
      ...(quote.couponCode && { couponCode: quote.couponCode, couponDiscountMinor: quote.couponDiscountMinor }),
      prepaidDiscountMinor: quote.prepaidDiscountMinor,
      deliveryMinor: quote.deliveryMinor, taxMinor: quote.taxMinor, totalMinor: quote.totalMinor,
      items: { create: allocateCheckoutLines(quote).map(line => ({ ...line, currency: quote.currency,
        marketplaceShopId: line.marketplaceShopId ?? shops[line.variantId] })) },
      payment: { create: { method: input.paymentMethod, amountMinor: quote.totalMinor, currency: quote.currency,
        ...(input.paymentMethod === "SSLCOMMERZ" && { status: "PAID" }) } },
      events: { create: { type: "ORDER_PLACED", status: "UNFULFILLED" } },
    },
    include: { items: true },
  });
  await createOrderParcels(tx, order.id, allocations);
  return savedOrderPurchase(order);
}

export async function submitCheckout(raw: unknown, marketId: MarketId, guestKey: string, shopperId?: string | null, staffActivity = false): Promise<SubmitResult> {
  const unavailable = { kind: "unavailable", message: checkoutClosed } as const;
  if (!isOperatingDatabase()) return unavailable;
  const operating = checkoutOperating(marketId, "COD");
  const parsed = submissionInput.safeParse(raw);
  if (!parsed.success) return operating ? { kind: "invalid", message: "Your checkout details are incomplete. Review the order before trying again." } : unavailable;
  const input = canonicalOrder(parsed.data);
  if (input.marketId !== marketId) return operating ? { kind: "invalid", message: "Your shopping region changed. Return to the cart before placing an order." } : unavailable;
  const { attemptId, reviewToken } = parsed.data;
  const hash = requestDigest(JSON.stringify(input));
  try {
    return await getDb().$transaction(async (tx): Promise<SubmitResult> => {
      const attempt = await lockAttempt(tx, attemptId);
      if (!attempt || attempt.guestKey !== guestKey || !validateReviewActor(attempt, shopperId) || attempt.requestHash !== hash || attempt.abandonedAt ||
          (attempt.marketId && attempt.marketId !== marketId) || (attempt.paymentMethod && attempt.paymentMethod !== "COD")) return operating ? attemptConflict() : unavailable;
      const existing = placedOrder(attempt);
      if (existing) return existing;
      if (!operating) return unavailable;

      await validateCheckoutCart(tx, input, shopperId, true);
      await lockQuoteRows(tx, input);
      const { quote, renewed } = await repriceCheckoutReview(tx, input, guestKey, attempt);
      if (renewed || !equalDigest(quote.reviewToken, reviewToken)) return {
        kind: "changed", quote,
        ...(renewed && { message: "Your review expired. Check the refreshed order before continuing." }),
      };
      const shops = await snapshotShops(tx, quote);
      const context = purchaseContext(input, attemptId, guestKey, hash);
      const legacy = await reservePurchaseStock(tx, context, quote.lines);
      const placed = await placeReservedPurchase(tx, context, quote.lines, legacy,
        (sameTransaction, allocations) => createNativeOrder(sameTransaction, input, quote, attemptId, shops, allocations, shopperId ?? undefined, staffActivity));
      if (placed.kind === "refund_required") throw new Error("Cash collection cannot have a verified payment exception.");
      return placed;
    });
  } catch (error) {
    if (error instanceof CommerceError) return error.detail;
    throw error;
  }
}

// Recover a lost response, or seal an unused attempt so it cannot place an order later.
export async function recoverCheckout(value: unknown, guestKey: string, marketId?: MarketId, shopperId?: string | null): Promise<RecoverResult> {
  const parsed = uuid.safeParse(value);
  if (!parsed.success || !isOperatingDatabase()) return attemptConflict();
  const attemptId = parsed.data;
  return getDb().$transaction(async (tx): Promise<RecoverResult> => {
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt || attempt.guestKey !== guestKey || !validateReviewActor(attempt, shopperId) || (marketId && attempt.marketId && attempt.marketId !== marketId) ||
        (attempt.paymentMethod && attempt.paymentMethod !== "COD")) return attemptConflict();
    const existing = placedOrder(attempt);
    if (existing) return existing;
    if (!attempt.abandonedAt) {
      await tx.checkoutAttempt.update({ where: { id: attemptId }, data: { abandonedAt: new Date() } });
    }
    return { kind: "abandoned" };
  });
}

export const orderDetails = {
  items: { orderBy: [{ sku: "asc" }, { personalization: "asc" }] },
  payment: true,
} satisfies Prisma.OrderInclude;

const shopperOrderDetails = {
  ...orderDetails,
  bangladeshShipment: bangladeshTrackingHistory,
  bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
  parcels: shopperParcelHistory,
} satisfies Prisma.OrderInclude;

export type SavedOrder = Prisma.OrderGetPayload<{ include: typeof shopperOrderDetails }>;

export async function guestOrder(id: string, guestKey: string | null, shopperId?: string): Promise<SavedOrder | null> {
  if (!uuid.safeParse(id).success) return null;
  return getDb().order.findFirst({ where: { id, OR: [
    ...(guestKey ? [{ shopperId: null, attempt: { guestKey } }] : []),
    ...(shopperId ? [{ shopperId }] : []),
  ] }, include: shopperOrderDetails });
}

export async function listGuestOrders(guestKey: string) {
  return getDb().order.findMany({
    where: { attempt: { guestKey } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30,
    select: { id: true, reference: true, status: true, fulfillmentStatus: true, createdAt: true,
      bangladeshShipment: bangladeshTrackingSummary, bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
      parcels: shopperParcelSummary },
  });
}
