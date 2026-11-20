import { z } from "zod";
import { compareCartItems } from "../cart/model.ts";
import type { DbReader } from "../db/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { hybridDemoMode } from "../release-config.ts";
import { checkoutInput, type QuoteLine } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { quoteDigest } from "./guest.ts";
import { paypalSandboxConfig } from "./paypal-config.ts";
import type { PayPalAddress } from "./paypal-provider.ts";
import { addressText as plainText, contiguousStates, usPhone, usPostalCode } from "./address.ts";
import { configuredPayment, providerMarket, roundedMerchandiseTax } from "./market-commerce.ts";
import { marketConfiguration } from "../market-config.ts";
import { quoteMerchandise } from "./checkout-merchandise.ts";

export const paypalCheckoutInput = z.strictObject({
  items: checkoutInput.shape.items,
  cart: checkoutInput.shape.cart,
  customer: z.strictObject({
    country: z.literal("US"),
    name: plainText(2, 100),
    email: z.union([z.email().max(254), z.literal("")]).optional().transform(value => value?.toLowerCase() || undefined),
    phone: usPhone,
    addressLine1: plainText(5, 120),
    addressLine2: z.union([plainText(1, 120), z.literal("")]).optional().transform(value => value || undefined),
    city: plainText(2, 100),
    state: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/)),
    postalCode: usPostalCode,
  }),
});
export type PayPalCheckoutInput = z.output<typeof paypalCheckoutInput>;
const demoCustomer: PayPalCheckoutInput["customer"] = {
  country: "US", name: "GriipBuddy Demo Shopper", email: "demo-order@example.invalid",
  phone: "+12025550100", addressLine1: "100 Test Avenue", addressLine2: undefined, city: "Washington", state: "DC", postalCode: "20001",
};
export type PayPalQuote = {
  currency: "USD";
  lines: QuoteLine[];
  subtotalMinor: number;
  discountMinor: number;
  merchandiseSubtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  taxLabel?: string;
  policyRevision?: number;
  taxBasisPoints?: number;
  marketRevision?: number;
  totalMinor: number;
  deliveryLabel: string;
};

export const storedPayPalQuote = z.strictObject({
  currency: z.literal("USD"),
  lines: z.array(z.strictObject({
    variantId: z.string(), productName: z.string(), variantName: z.string(), sku: z.string(),
    quantity: z.int().positive(), unitPriceMinor: z.int().nonnegative(), unitDiscountMinor: z.int().nonnegative(),
    lineTotalMinor: z.int().nonnegative(), personalization: z.string().optional(), marketplaceShopId: z.uuid().optional(),
    productIdSnapshot: z.string().optional(), offerIdSnapshot: z.uuid().optional(),
    cartOfferIdSnapshot: z.uuid().optional(), cartVariantIdSnapshot: z.string().optional(),
    optionsSnapshot: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    imageSrcSnapshot: z.string().optional(), imageAltSnapshot: z.string().optional(),
    marketplaceShopNameSnapshot: z.string().optional(), offerRevision: z.int().nonnegative().optional(),
  })).min(1),
  subtotalMinor: z.int().nonnegative(),
  discountMinor: z.int().nonnegative(),
  merchandiseSubtotalMinor: z.int().nonnegative(),
  shippingMinor: z.int().nonnegative(),
  taxMinor: z.int().nonnegative(),
  taxLabel: z.string().optional(),
  policyRevision: z.int().nonnegative().optional(),
  taxBasisPoints: z.int().min(0).max(10_000).optional(),
  marketRevision: z.int().positive().optional(),
  totalMinor: z.int().positive(),
  deliveryLabel: z.string(),
});

export function normalizedPayPalInput(raw: unknown) {
  const input = paypalCheckoutInput.safeParse(raw);
  if (!input.success) throw new CommerceError({
    kind: "invalid", message: "Check your US shipping address, contact details, and cart quantities.",
  });
  if (!contiguousStates.has(input.data.customer.state)) throw new CommerceError({
    kind: "unavailable", message: "The US preview covers the contiguous 48 states and Washington, DC.",
  });
  return { customer: hybridDemoMode() ? demoCustomer : input.data.customer,
    items: [...input.data.items].sort(compareCartItems), ...(input.data.cart && { cart: input.data.cart }) };
}

export async function quotePayPalCheckout(db: DbReader, input: PayPalCheckoutInput,
  marketId: MarketId | undefined = providerMarket("PAYPAL")): Promise<PayPalQuote> {
  const config = paypalSandboxConfig(marketId);
  const operating = config && configuredPayment(config.marketId, "PAYPAL");
  if (!config || !operating) throw new CommerceError({ kind: "unavailable", message: "A configured test payment and shipping rate are required before checkout can quote an order." });
  const { market } = operating;
  const policy = market.pricing.taxTreatment === "MERCHANDISE_RATE" ? await db.checkoutPolicy.findUnique({ where: { marketId: market.id } }) : null;
  if (market.pricing.taxTreatment === "MERCHANDISE_RATE" && (!policy?.enabled || policy.countryCode !== market.countryCode ||
    policy.currency !== market.currency || policy.taxTreatment !== market.pricing.taxTreatment ||
    policy.taxBasisPoints === null || policy.taxBasisPoints < 0 || policy.taxBasisPoints > 10_000 || !policy.taxLabel?.trim())) {
    throw new CommerceError({ kind: "unavailable", message: "This checkout needs a configured market tax policy." });
  }
  const lines = await quoteMerchandise(db, {
    marketId: market.id, paymentMethod: "PAYPAL", items: input.items, destination: {
      country: input.customer.country, district: input.customer.state.toLowerCase(),
      postalCode: input.customer.postalCode, method: "sandbox-standard",
    },
  });

  const subtotalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
  const merchandiseSubtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const shippingMinor = config.shippingMinor;
  const taxMinor = policy?.taxBasisPoints != null ? roundedMerchandiseTax(merchandiseSubtotalMinor, policy.taxBasisPoints) : 0;
  const totalMinor = merchandiseSubtotalMinor + shippingMinor + taxMinor;
  if (totalMinor < 1 || subtotalMinor + shippingMinor + taxMinor > 99_999_999) throw new CommerceError({
    kind: "invalid", message: "This cart falls outside the test payment amount limits. Adjust the cart and try again.",
  });

  return {
    currency: "USD", lines, subtotalMinor, discountMinor: subtotalMinor - merchandiseSubtotalMinor,
    merchandiseSubtotalMinor, shippingMinor, taxMinor, totalMinor, deliveryLabel: `${market.name} test shipping`,
    marketRevision: market.revision, taxLabel: policy?.taxLabel || "Tax (test)",
    ...(policy?.taxBasisPoints != null && { policyRevision: policy.revision, taxBasisPoints: policy.taxBasisPoints }),
  };
}

export function paypalQuoteToken(guestKey: string, input: PayPalCheckoutInput, quote: PayPalQuote, marketId: MarketId,
  reviewActor: string | null, expiresAt: number) {
  const digest = quoteDigest(JSON.stringify({ scope: "paypal-sandbox", marketId, revision: quote.marketRevision ?? marketConfiguration(marketId).revision,
    guestKey, input, reviewActor, expiresAt, quote: storedPayPalQuote.parse(quote) }));
  return `${expiresAt}.${digest}`;
}

export function paypalShippingAddress(customer: PayPalCheckoutInput["customer"]): PayPalAddress {
  return {
    address_line_1: customer.addressLine1, ...(customer.addressLine2 && { address_line_2: customer.addressLine2 }),
    admin_area_2: customer.city, admin_area_1: customer.state, postal_code: customer.postalCode, country_code: customer.country,
  };
}
