import { z } from "zod";
import { cartItemKey, MAX_CART_LINES, MAX_QUANTITY, validVariantId, variantQuantities } from "../cart/model.ts";
import { MAX_PERSONALIZATION_LENGTH } from "../catalog/personalization.ts";
import { couponCodeInput } from "../marketplace/coupon-input.ts";
import { manualPaymentMethods, type ManualPaymentInstructions } from "./manual-payment-methods.ts";

export const uuid = z.uuid();
const plainText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((value) => [...value].every((char) => char >= " " && char !== "\u007f"));
const optionalText = (max: number) => plainText(0, max).optional().transform((value) => value || null);

export function demoCheckoutEmail(address: string | null | undefined, fallback = "checkout@example.invalid") {
  const email = address?.toLowerCase();
  if (!email) return undefined;
  return /^[^@]+@example\.invalid$/.test(email) ? email : fallback;
}

const bangladeshDigits = (value: string) => value.replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));
const bangladeshPhone = z.string().max(28).transform((value) => bangladeshDigits(value).trim().replace(/[\s()-]/g, ""))
  .pipe(z.string().regex(/^(?:\+?880|0)1[3-9]\d{8}$/))
  .transform((value) => `+880${value.slice(-10)}`);

export const checkoutInput = z.object({
  marketId: z.enum(["bd", "us"]),
  items: z.array(z.object({
    variantId: z.string().refine(validVariantId),
    quantity: z.number().int().min(1).max(MAX_QUANTITY),
    personalization: plainText(1, MAX_PERSONALIZATION_LENGTH).optional(),
  })).min(1).max(MAX_CART_LINES)
    .refine((items) => new Set(items.map(cartItemKey)).size === items.length)
    .refine((items) => [...variantQuantities(items).values()].every(quantity => quantity <= MAX_QUANTITY)),
  customer: z.object({
    country: z.literal("BD").optional(),
    name: plainText(2, 100),
    phone: bangladeshPhone,
    email: z.union([z.email().max(254), z.literal("")]).optional().transform((value) => value?.toLowerCase() || null),
    district: z.string().trim().regex(/^[a-z][a-z-]{1,39}$/),
    locality: plainText(2, 100),
    address: plainText(5, 240),
    postalCode: optionalText(4).transform(value => value && bangladeshDigits(value)).refine((value) => value === null || /^\d{4}$/.test(value)),
    landmark: plainText(0, 120).nullish().transform(value => value || undefined),
    alternatePhone: z.union([bangladeshPhone, z.literal("")]).nullish().transform(value => value || undefined),
    instructions: plainText(0, 180).nullish().transform(value => value || undefined),
  }),
  deliveryMethod: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  paymentMethod: z.literal("COD"),
  gift: z.object({ note: plainText(0, 240) }).strict().optional(),
  couponCode: couponCodeInput.optional(),
});

export const submissionInput = checkoutInput.extend({
  attemptId: uuid,
  reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export const nativeCheckoutInput = checkoutInput.extend({
  paymentMethod: z.enum(["COD", ...manualPaymentMethods]),
});

export const walletTransaction = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,32}$/);

const manualProof = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("receipt") }).strict(),
  z.object({ kind: z.literal("transaction"), payerPhone: bangladeshPhone, transactionId: walletTransaction }).strict(),
]);

export const nativeSubmissionInput = nativeCheckoutInput.extend({
  ...submissionInput.pick({ attemptId: true, reviewToken: true }).shape,
  manualProof: manualProof.optional(),
});

export const prepaidCheckoutInput = checkoutInput.extend({
  marketId: z.literal("bd"),
  paymentMethod: z.literal("SSLCOMMERZ"),
  customer: checkoutInput.shape.customer.refine(customer => customer.email !== null),
});

export const prepaidSubmissionInput = prepaidCheckoutInput.extend({
  attemptId: uuid,
  reviewToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export type NativeCheckoutDetails = z.input<typeof nativeCheckoutInput>;
export type NormalizedNativeCheckout = z.output<typeof nativeCheckoutInput>;
export type ManualPaymentProof = z.output<typeof manualProof>;
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
  currency: "BDT";
  lines: QuoteLine[];
  districtLabel: string;
  deliveryLabel: string;
  deliveryGuidance: string | null;
  reviewToken: string;
  manualPayment?: ManualPaymentInstructions;
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
