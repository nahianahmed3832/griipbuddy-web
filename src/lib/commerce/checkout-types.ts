import { z } from "zod";
import { MAX_CART_LINES, MAX_QUANTITY, validVariantId, variantQuantities } from "../cart/model.ts";
import { MAX_PERSONALIZATION_LENGTH } from "../catalog/personalization.ts";
import { couponCodeInput } from "../marketplace/coupon-input.ts";
import { isMarketId, type Currency, type MarketId } from "../../config/markets.ts";
import { addressText as plainText, checkoutAddressInput } from "./address.ts";

export const uuid = z.uuid();

export const checkoutInput = z.object({
  marketId: z.custom<MarketId>(isMarketId),
  items: z.array(z.object({
    variantId: z.string().refine(validVariantId),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
    personalization: plainText(1, MAX_PERSONALIZATION_LENGTH).optional(),
    offerId: uuid.optional(),
    cartOfferId: uuid.optional(),
    cartVariantId: z.string().refine(validVariantId).optional(),
  })).min(1).max(MAX_CART_LINES)
    .refine((items) => new Set(items.map(item => JSON.stringify([item.variantId, item.personalization ?? ""]))).size === items.length)
    .refine((items) => new Set(items.map(item => JSON.stringify([
      item.cartVariantId ?? item.variantId, item.cartOfferId ?? null, item.personalization ?? "",
    ]))).size === items.length)
    .refine((items) => [...variantQuantities(items).values()].every(quantity => quantity <= MAX_QUANTITY)),
  customer: checkoutAddressInput,
  deliveryMethod: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  paymentMethod: z.literal("COD"),
  gift: z.object({ note: plainText(0, 240) }).strict().optional(),
  couponCode: couponCodeInput.optional(),
});

export const submissionInput = checkoutInput.extend({
  attemptId: uuid,
  reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export const prepaidCheckoutInput = checkoutInput.extend({
  paymentMethod: z.literal("SSLCOMMERZ"),
  customer: checkoutInput.shape.customer.refine(customer => customer.email !== null),
});

export const prepaidSubmissionInput = prepaidCheckoutInput.extend({
  attemptId: uuid,
  reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export type CheckoutDetails = z.input<typeof checkoutInput>;
export type NormalizedCheckout = z.output<typeof checkoutInput>;
export type PrepaidCheckoutDetails = z.input<typeof prepaidCheckoutInput>;
export type NormalizedPrepaidCheckout = z.output<typeof prepaidCheckoutInput>;
export type CheckoutSubmission = z.input<typeof submissionInput>;

export type QuoteLine = {
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: number;
  unitPriceMinor: number;
  unitDiscountMinor: number;
  lineTotalMinor: number;
  personalization?: string;
  couponDiscountMinor?: number;
  prepaidDiscountMinor?: number;
  productIdSnapshot?: string;
  offerIdSnapshot?: string;
  cartOfferIdSnapshot?: string;
  cartVariantIdSnapshot?: string;
  optionsSnapshot?: { name: string; value: string }[];
  imageSrcSnapshot?: string;
  imageAltSnapshot?: string;
  marketplaceShopNameSnapshot?: string;
  marketplaceShopId?: string;
  offerRevision?: number;
};

export type OrderTotals = {
  subtotalMinor: number;
  discountMinor: number;
  couponCode?: string | null;
  couponDiscountMinor?: number;
  prepaidDiscountMinor?: number;
  deliveryMinor: number;
  taxMinor: number;
  taxLabel: string;
  totalMinor: number;
};

export type CheckoutQuote = OrderTotals & {
  currency: Currency;
  lines: QuoteLine[];
  districtLabel: string;
  deliveryLabel: string;
  deliveryGuidance: string | null;
  reviewToken: string;
};

export type DeliveryChoice = {
  district: string;
  districtLabel: string;
  method: string;
  label: string;
  chargeMinor: number;
  guidance: string | null;
};

export type CheckoutFailure = {
  kind: "invalid" | "unavailable" | "conflict" | "error";
  message: string;
  issues?: string[];
};
export type ReviewResult = { kind: "review"; attemptId: string; quote: CheckoutQuote } | CheckoutFailure;
export type OrderPlaced = { kind: "placed"; orderId: string; purchased: NormalizedCheckout["items"] };
export type SubmitResult = OrderPlaced | { kind: "changed"; quote: CheckoutQuote } | CheckoutFailure;
export type RecoverResult = OrderPlaced | { kind: "abandoned" } | CheckoutFailure;
export type PrepaidPaymentResult = (OrderPlaced & { direct: boolean }) | CheckoutFailure |
  { kind: "changed"; quote: CheckoutQuote } |
  { kind: "continue"; redirectUrl: string } |
  { kind: "pending" | "abandoned"; message: string };
