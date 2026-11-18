import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isOperatingDatabase } from "../db/local.ts";
import { hybridDemoMode, marketplaceMode, orderIntakeOpen, productionMode } from "../release-config.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { devOfferPricing } from "../marketplace/dev-offer.ts";
import { storeShop } from "../marketplace/constants.ts";
import { checkoutCoupon } from "../marketplace/coupons.ts";
import { applyCoupon } from "../marketplace/coupon-input.ts";
import { marketVisibilitySelect, merchantProductEligible } from "../marketplace/market-grants.ts";
import { personalizationAvailable } from "../catalog/personalization.ts";
import { compareCartItems, variantQuantities } from "../cart/model.ts";
import {
  demoCheckoutEmail, nativeCheckoutInput, nativeSubmissionInput, uuid, type CheckoutQuote, type DeliveryChoice, type ManualPaymentProof,
  type NormalizedNativeCheckout, type NormalizedPrepaidCheckout, type OrderPlaced, type RecoverResult, type ReviewResult, type SubmitResult,
} from "./checkout-types.ts";
import { checkoutClosed, CommerceError } from "./errors.ts";
import { integratedCheckout, recoveredDeliveryChoices } from "./integrated-checkout.ts";
import { equalDigest, quoteDigest, requestDigest } from "./guest.ts";
import { prepaidAvailable } from "./prepaid-config.ts";
import { manualPaymentInstructions } from "./manual-payment-config.ts";
import { isManualPaymentMethod } from "./manual-payment-methods.ts";
import { bangladeshTrackingHistory, bangladeshTrackingSummary } from "./bangladesh-shipment.ts";
import { notifyOrder } from "./order-notifications.ts";
import { returnTermsForCheckout } from "./order-return-terms.ts";

const sqlIntMax = 2_147_483_647;

function allowed(marketId: MarketId) {
  return marketId === "bd" && isOperatingDatabase() && !(productionMode() && process.env.BD_CHECKOUT_HANDOFF === "1");
}

type BangladeshCheckout = NormalizedNativeCheckout | NormalizedPrepaidCheckout;
type BangladeshPayment = BangladeshCheckout["paymentMethod"];

async function getPolicy(db: DbReader, marketId: MarketId, payment: BangladeshPayment) {
  if (!allowed(marketId) || !orderIntakeOpen()) return null;
  const policy = await db.checkoutPolicy.findUnique({ where: { marketId } });
  const enabled = payment === "COD" ? policy?.codEnabled
    : payment === "SSLCOMMERZ" ? prepaidAvailable() : Boolean(manualPaymentInstructions(payment));
  if (!policy?.enabled || !enabled || policy.countryCode !== markets.bd.countryCode ||
      policy.currency !== "BDT" || policy.taxTreatment !== "MERCHANDISE_RATE" ||
      policy.taxBasisPoints === null || !policy.taxLabel?.trim()) return null;
  return { ...policy, currency: policy.currency, taxBasisPoints: policy.taxBasisPoints, taxLabel: policy.taxLabel };
}

export async function deliveryChoices(marketId: MarketId, payment: BangladeshPayment = "COD"): Promise<DeliveryChoice[]> {
  if (integratedCheckout()) return payment === "COD" ? recoveredDeliveryChoices(marketId) : [];
  if (!await getPolicy(getDb(), marketId, payment)) return [];
  const rows = await getDb().deliveryZone.findMany({
    where: { marketId, enabled: true, ...(payment === "COD" && { codEligible: true }), chargeMinor: { not: null } },
    orderBy: [{ districtLabel: "asc" }, { label: "asc" }],
  });
  return rows.flatMap(({ district, districtLabel, method, label, chargeMinor, guidance }) =>
    chargeMinor === null ? [] : [{ district, districtLabel, method, label, chargeMinor, guidance }],
  );
}

export function canonicalOrder(input: NormalizedPrepaidCheckout): NormalizedPrepaidCheckout;
export function canonicalOrder(input: NormalizedNativeCheckout): NormalizedNativeCheckout;
export function canonicalOrder(input: BangladeshCheckout): BangladeshCheckout {
  const customer = hybridDemoMode() ? {
    ...input.customer,
    name: "GriipBuddy Demo Buyer", phone: "+8801700000000", email: demoCheckoutEmail(input.customer.email) ?? null,
    locality: "Demo area", address: "Demo street address", postalCode: null,
    landmark: input.customer.landmark ? "Demo landmark" : undefined,
    alternatePhone: input.customer.alternatePhone ? "+8801700000000" : undefined,
    instructions: input.customer.instructions ? "Demo delivery instructions" : undefined,
  } : input.customer;
  return {
    marketId: input.marketId,
    items: [...input.items].sort(compareCartItems),
    customer,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    gift: marketplaceMode() ? input.gift : undefined,
    ...(marketplaceMode() && input.couponCode && { couponCode: input.couponCode }),
  } as BangladeshCheckout;
}

export async function calculateQuote(db: DbReader, input: BangladeshCheckout, guestKey: string, attemptId: string): Promise<CheckoutQuote> {
  const policy = await getPolicy(db, input.marketId, input.paymentMethod);
  if (!policy) throw new CommerceError({ kind: "unavailable", message: checkoutClosed });

  const zone = await db.deliveryZone.findUnique({
    where: { marketId_district_method: { marketId: input.marketId, district: input.customer.district, method: input.deliveryMethod } },
  });
  if (!zone?.enabled || (input.paymentMethod === "COD" && !zone.codEligible) || zone.chargeMinor === null) {
    throw new CommerceError({ kind: "unavailable", message: "This delivery option is unavailable for the selected district. Choose another supported destination or delivery option." });
  }

  const variants = await db.variant.findMany({
    where: {
      id: { in: input.items.map((item) => item.variantId) },
    },
    include: { product: { include: { marketplaceShop: { select: marketVisibilitySelect } } }, inventory: true,
      offers: { where: { marketId: input.marketId } } },
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const requested = variantQuantities(input.items);
  const marketplace = marketplaceMode();
  const now = new Date();
  const campaign = await devOfferPricing(input.marketId, variants, now).catch(() => {
    throw new CommerceError({ kind: "unavailable", message: "Offer pricing is temporarily unavailable. Try reviewing again." });
  });
  const freeDeliveryVariants = new Set<string>();
  const issues: string[] = [];
  const merchandise = input.items.flatMap(({ variantId, quantity, personalization }) => {
    const variant = byId.get(variantId);
    const offer = variant?.offers[0];
    if (!variant?.active || variant.product.publication !== "ACTIVE" || !merchantProductEligible(variant.product, input.marketId) ||
        !offer?.eligible || offer.currency !== policy.currency) {
      issues.push(variant ? `${variant.product.name} (${variant.label}) is unavailable in Bangladesh.` : "An item in your cart is no longer in the catalog.");
      return [];
    }
    const stock = variant.inventory?.available ?? 0;
    const requestedQuantity = requested.get(variantId) ?? quantity;
    if (stock < requestedQuantity) {
      const issue = `${variant.product.name} (${variant.label}): ${stock} available, ${requestedQuantity} requested.`;
      if (!issues.includes(issue)) issues.push(issue);
      return [];
    }
    const { personalizationPrompt, personalizationRequired } = variant.product;
    const settings = marketplace && personalizationPrompt ? { prompt: personalizationPrompt, required: personalizationRequired } : undefined;
    if (!personalizationAvailable(settings, personalization)) {
      issues.push(`${variant.product.name}: review its personalization instructions before checking out.`);
      return [];
    }
    const saleMinor = offer.amountMinor - activeDiscount(offer, now);
    const special = campaign?.price(variant, { amountMinor: saleMinor, regularMinor: offer.amountMinor });
    const unitPriceMinor = special?.regularMinor ?? offer.amountMinor;
    const amountMinor = special?.amountMinor ?? saleMinor;
    const unitDiscountMinor = unitPriceMinor - amountMinor;
    if (special?.freeDelivery) freeDeliveryVariants.add(variantId);
    return [{
      variantId, productName: variant.product.name, variantName: variant.label, sku: variant.sku, quantity,
      unitPriceMinor, unitDiscountMinor, lineTotalMinor: amountMinor * quantity,
      ...(personalization && { personalization }),
    }];
  });
  if (issues.length) throw new CommerceError({ kind: "unavailable", message: "Some items in your cart are no longer available in the requested quantities.", issues });

  const subtotalMinor = merchandise.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
  if (subtotalMinor > sqlIntMax) {
    throw new CommerceError({ kind: "invalid", message: "This cart exceeds the checkout limit. Please split it into smaller orders." });
  }
  const coupon = input.couponCode ? await checkoutCoupon(db, input.couponCode, merchandise.map((line) => ({
    shopId: byId.get(line.variantId)?.product.marketplaceShopId ?? storeShop.id,
    netMinor: line.lineTotalMinor,
  }))) : null;
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
  const taxMinor = Math.floor(((subtotalMinor - discountMinor) * policy.taxBasisPoints + 5000) / 10000);
  const deliveryMinor = merchandise.every(line => freeDeliveryVariants.has(line.variantId)) ? 0 : zone.chargeMinor;
  const totalMinor = subtotalMinor - discountMinor + deliveryMinor + taxMinor;
  if (input.paymentMethod === "SSLCOMMERZ" && (totalMinor < 1000 || totalMinor > 50_000_000)) {
    throw new CommerceError({ kind: "unavailable", message: "Online payment is available for order totals from ৳10 to ৳500,000." });
  }
  if (isManualPaymentMethod(input.paymentMethod) && totalMinor === 0) {
    throw new CommerceError({ kind: "unavailable", message: "No amount is due. Choose cash on delivery or remove the coupon." });
  }
  if (coupon && totalMinor === 0) {
    throw new CommerceError({ kind: "unavailable", message: "This coupon leaves no amount due for cash on delivery. Remove it or use another code." });
  }
  if (totalMinor > sqlIntMax) {
    throw new CommerceError({ kind: "invalid", message: "This cart exceeds the checkout limit. Please split it into smaller orders." });
  }

  const manualPayment = isManualPaymentMethod(input.paymentMethod) ? manualPaymentInstructions(input.paymentMethod) : undefined;
  const quote = {
    currency: policy.currency, lines, districtLabel: zone.districtLabel, deliveryLabel: zone.label, deliveryGuidance: zone.guidance,
    subtotalMinor, discountMinor, deliveryMinor, taxMinor, taxLabel: policy.taxLabel, totalMinor,
    ...(coupon && { couponCode: input.couponCode, couponDiscountMinor: coupon.total }),
    ...(prepaid && { prepaidDiscountMinor: prepaid.total }),
    ...(manualPayment && { manualPayment }),
  };
  return { ...quote, reviewToken: quoteDigest(JSON.stringify({ guestKey, attemptId, input, quote })) };
}

export async function reviewCheckout(raw: unknown, marketId: MarketId, guestKey: string): Promise<ReviewResult> {
  if (!allowed(marketId) || !orderIntakeOpen()) return { kind: "unavailable", message: checkoutClosed };
  const parsed = nativeCheckoutInput.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", message: "Check your contact details, delivery address, and cart quantities." };
  if (parsed.data.marketId !== marketId) return { kind: "invalid", message: "Your shopping region changed. Return to the cart before reviewing again." };
  try {
    const db = getDb();
    const input = canonicalOrder(parsed.data);
    const attemptId = randomUUID();
    const quote = await calculateQuote(db, input, guestKey, attemptId);
    await db.checkoutAttempt.create({ data: { id: attemptId, guestKey, requestHash: requestDigest(JSON.stringify(input)) } });
    return { kind: "review", attemptId, quote };
  } catch (error) {
    if (error instanceof CommerceError) return error.detail;
    throw error;
  }
}

type AttemptWithOrder = Prisma.CheckoutAttemptGetPayload<{ include: { order: { include: { items: true } } } }>;

export function placedOrder(attempt: AttemptWithOrder): OrderPlaced | null {
  if (!attempt.order) return null;
  return {
    kind: "placed", orderId: attempt.order.id,
    purchased: attempt.order.items.map(({ variantId, quantity, personalization }) => (
      { variantId, quantity, ...(personalization && { personalization }) }
    )).sort(compareCartItems),
  };
}

function attemptConflict() {
  return { kind: "conflict", message: "This checkout attempt cannot be reused. Check your recent order or start a new review." } as const;
}

export async function lockAttempt(tx: Prisma.TransactionClient, attemptId: string) {
  // Lock the review's unique row to serialize concurrent retries for this attempt.
  await tx.$queryRaw`SELECT "id" FROM "CheckoutAttempt" WHERE "id" = ${attemptId}::uuid FOR UPDATE`;
  return tx.checkoutAttempt.findUnique({ where: { id: attemptId }, include: { order: { include: { items: true } } } });
}

export async function lockQuoteRows(tx: Prisma.TransactionClient, input: BangladeshCheckout) {
  const variants = Prisma.join([...new Set(input.items.map(({ variantId }) => variantId))]);
  // Lock in a stable order. Staff price edits lock only the offer; stock edits lock only inventory.
  await tx.$queryRaw`SELECT "variantId" FROM "Inventory" WHERE "variantId" IN (${variants}) ORDER BY "variantId" COLLATE "C" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT "variantId" FROM "MarketOffer"
    WHERE "marketId" = ${input.marketId}::"MarketCode" AND "variantId" IN (${variants})
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

export async function changeBangladeshStock(tx: Prisma.TransactionClient, quote: CheckoutQuote, reserve: boolean) {
  const quantities = [...variantQuantities(quote.lines)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [variantId, quantity] of quantities) {
    const updated = await tx.inventory.updateMany({
      where: { variantId, ...(reserve && { available: { gte: quantity } }) },
      data: { available: reserve ? { decrement: quantity } : { increment: quantity } },
    });
    if (updated.count !== 1) throw new CommerceError({ kind: "unavailable", message: "Stock changed. Return to your cart and review your quantities." });
  }
}

export async function createBangladeshOrder(tx: Prisma.TransactionClient, input: BangladeshCheckout, quote: CheckoutQuote,
  attemptId: string, shops: Record<string, string | null>, shopperId?: string,
  evidence?: { proof: ManualPaymentProof; receipt?: Uint8Array<ArrayBuffer> }): Promise<OrderPlaced> {
  const { name, phone, email, district, locality, address, postalCode, landmark, alternatePhone, instructions } = input.customer;
  const deliveryAddress = [address, landmark && `Landmark: ${landmark}`, alternatePhone && `Alternate phone: ${alternatePhone}`,
    instructions && `Instructions: ${instructions}`].filter(Boolean).join(" · ");
  const manual = quote.manualPayment;
  if (manual && !evidence) throw new CommerceError({ kind: "invalid", message: "Provide proof of payment before placing the order." });
  const order = await tx.order.create({
    data: {
      attemptId, reference: `GB-${randomBytes(6).toString("hex").toUpperCase()}`, marketId: input.marketId, currency: quote.currency,
      measurementTest: !productionMode(),
      ...(marketplaceMode() && { shopperId, gift: Boolean(input.gift), giftNote: input.gift?.note || null,
        returnTerms: returnTermsForCheckout("bd") }),
      customerName: name, phone, email, district, districtLabel: quote.districtLabel, locality, address: deliveryAddress, postalCode,
      deliveryMethod: input.deliveryMethod, deliveryLabel: quote.deliveryLabel, deliveryGuidance: quote.deliveryGuidance, taxLabel: quote.taxLabel,
      subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor,
      ...(quote.couponCode && { couponCode: quote.couponCode, couponDiscountMinor: quote.couponDiscountMinor }),
      prepaidDiscountMinor: quote.prepaidDiscountMinor,
      deliveryMinor: quote.deliveryMinor, taxMinor: quote.taxMinor, totalMinor: quote.totalMinor,
      items: { create: quote.lines.map((line) => ({ ...line, currency: quote.currency, marketplaceShopId: shops[line.variantId] })) },
      payment: { create: { method: input.paymentMethod, amountMinor: quote.totalMinor, currency: quote.currency,
        ...(input.paymentMethod === "SSLCOMMERZ" && { status: "PAID" }),
        ...(manual && evidence && {
          status: "AWAITING_VERIFICATION" as const,
          manualProof: { create: { ...manual,
            ...(evidence.proof.kind === "transaction"
              ? { payerPhone: evidence.proof.payerPhone, submittedTransaction: evidence.proof.transactionId }
              : { receipt: evidence.receipt }),
          } },
        }),
      } },
      events: { create: { type: "ORDER_PLACED", status: "UNFULFILLED" } },
    },
    select: { id: true },
  });
  return { kind: "placed", orderId: order.id, purchased: input.items };
}

export async function submitCheckout(raw: unknown, marketId: MarketId, guestKey: string, shopperId?: string,
  receipt?: Uint8Array<ArrayBuffer>): Promise<SubmitResult> {
  if (!allowed(marketId)) return { kind: "unavailable", message: checkoutClosed };
  const parsed = nativeSubmissionInput.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", message: "Your checkout details are incomplete. Review the order before trying again." };
  const input = canonicalOrder(parsed.data);
  if (input.marketId !== marketId) return { kind: "invalid", message: "Your shopping region changed. Return to the cart before placing an order." };
  const { attemptId, reviewToken, manualProof } = parsed.data;
  const manual = isManualPaymentMethod(input.paymentMethod);
  if (manual ? !manualProof || (manualProof.kind === "receipt") !== Boolean(receipt) : Boolean(manualProof || receipt)) {
    return { kind: "invalid", message: "Upload a receipt or enter both the payer phone number and transaction ID." };
  }
  const evidence = manualProof ? { proof: manualProof, receipt } : undefined;
  const hash = requestDigest(JSON.stringify(input));
  try {
    let newOrder = false;
    const result = await getDb().$transaction(async (tx): Promise<SubmitResult> => {
      const attempt = await lockAttempt(tx, attemptId);
      if (!attempt || attempt.guestKey !== guestKey || attempt.requestHash !== hash || attempt.abandonedAt) return attemptConflict();
      const existing = placedOrder(attempt);
      if (existing) return existing;

      await lockQuoteRows(tx, input);
      const quote = await calculateQuote(tx, input, guestKey, attemptId);
      if (!equalDigest(quote.reviewToken, reviewToken)) return { kind: "changed", quote };
      const shops = await snapshotShops(tx, quote);
      await changeBangladeshStock(tx, quote, true);
      const placed = await createBangladeshOrder(tx, input, quote, attemptId, shops, shopperId, evidence);
      newOrder = true;
      return placed;
    });
    if (newOrder && result.kind === "placed") await notifyOrder(result.orderId, "received");
    return result;
  } catch (error) {
    if (error instanceof CommerceError) return error.detail;
    throw error;
  }
}

// Recover a lost response, or seal an unused attempt so it cannot place an order later.
export async function recoverCheckout(value: unknown, guestKey: string): Promise<RecoverResult> {
  const parsed = uuid.safeParse(value);
  if (!parsed.success || !isOperatingDatabase()) return attemptConflict();
  const attemptId = parsed.data;
  return getDb().$transaction(async (tx): Promise<RecoverResult> => {
    const attempt = await lockAttempt(tx, attemptId);
    if (!attempt || attempt.guestKey !== guestKey) return attemptConflict();
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
  sellerFulfillments: { where: { status: "HANDED_OFF" }, select: { status: true } },
} satisfies Prisma.OrderInclude;

export type SavedOrder = Prisma.OrderGetPayload<{ include: typeof shopperOrderDetails }>;

function visibleOrder(id: string, guestKey: string | null, shopperId?: string, marketId?: MarketId) {
  return { id, marketId, OR: [
    ...(guestKey ? [{ shopperId: null, attempt: { guestKey } }] : []),
    ...(shopperId ? [{ shopperId }] : []),
  ] } satisfies Prisma.OrderWhereInput;
}

export async function visibleOrderMarket(id: string, guestKey: string | null, shopperId?: string) {
  if (!uuid.safeParse(id).success) return null;
  return getDb().order.findFirst({ where: visibleOrder(id, guestKey, shopperId), select: { marketId: true } });
}

export async function guestOrder(id: string, guestKey: string | null, shopperId?: string, marketId?: MarketId): Promise<SavedOrder | null> {
  if (!uuid.safeParse(id).success) return null;
  return getDb().order.findFirst({ where: visibleOrder(id, guestKey, shopperId, marketId), include: shopperOrderDetails });
}

export async function listGuestOrders(guestKey: string) {
  return getDb().order.findMany({
    where: { shopperId: null, attempt: { guestKey } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30,
    select: { id: true, reference: true, status: true, fulfillmentStatus: true, createdAt: true,
      bangladeshShipment: bangladeshTrackingSummary, bangladeshRefusedParcelReceipt: { select: { receivedAt: true } } },
  });
}
