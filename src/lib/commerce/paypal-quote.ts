import { z } from "zod";
import { compareCartItems, variantQuantities } from "../cart/model.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { personalizationAvailable } from "../catalog/personalization.ts";
import type { DbReader } from "../db/client.ts";
import { storeShop } from "../marketplace/constants.ts";
import { marketVisibilitySelect, merchantProductEligible } from "../marketplace/market-grants.ts";
import { hybridDemoMode, hybridStoreMode } from "../release-config.ts";
import { checkoutInput, demoCheckoutEmail, type QuoteLine } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { quoteDigest } from "./guest.ts";
import { paypalSandboxConfig } from "./paypal-config.ts";
import type { PayPalAddress } from "./paypal-provider.ts";
import { usPreviewDeliveryArea, usPreviewStates, usSampleRecipient } from "./us-delivery.ts";

const plainText = (min: number, max: number) => z.string().trim().min(min).max(max).regex(/^[^\u0000-\u001F\u007F]+$/u);
const usPhone = z.string().max(28).transform(value => value.trim().replace(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^(?:\+?1)?[2-9]\d{2}[2-9]\d{6}$/))
  .transform(value => `+1${value.slice(-10)}`);

export const paypalCheckoutInput = z.strictObject({
  items: checkoutInput.shape.items,
  customer: z.strictObject({
    country: z.literal("US"),
    name: plainText(2, 100),
    email: z.union([z.email().max(254), z.literal("")]).optional().transform(value => value?.toLowerCase() || undefined),
    phone: usPhone,
    addressLine1: plainText(5, 120),
    addressLine2: z.union([plainText(1, 120), z.literal("")]).optional().transform(value => value || undefined),
    city: plainText(2, 100),
    state: z.string().trim().toUpperCase().pipe(z.string().regex(/^[A-Z]{2}$/)),
    postalCode: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/),
  }),
});
export type PayPalCheckoutInput = z.output<typeof paypalCheckoutInput>;
type PayPalQuoteLine = QuoteLine & { marketplaceShopId?: string };
export type PayPalQuote = {
  currency: "USD";
  lines: PayPalQuoteLine[];
  subtotalMinor: number;
  discountMinor: number;
  merchandiseSubtotalMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  deliveryLabel: string;
};

export const storedPayPalQuote = z.strictObject({
  currency: z.literal("USD"),
  lines: z.array(z.strictObject({
    variantId: z.string(), productName: z.string(), variantName: z.string(), sku: z.string(),
    quantity: z.int().positive(), unitPriceMinor: z.int().nonnegative(), unitDiscountMinor: z.int().nonnegative(),
    lineTotalMinor: z.int().nonnegative(), personalization: z.string().optional(), marketplaceShopId: z.uuid().optional(),
  })).min(1),
  subtotalMinor: z.int().nonnegative(),
  discountMinor: z.int().nonnegative(),
  merchandiseSubtotalMinor: z.int().nonnegative(),
  shippingMinor: z.int().nonnegative(),
  taxMinor: z.literal(0),
  totalMinor: z.int().positive(),
  deliveryLabel: z.string(),
});

export function normalizedPayPalInput(raw: unknown) {
  const input = paypalCheckoutInput.safeParse(raw);
  if (!input.success) throw new CommerceError({
    kind: "invalid", message: "Check your US shipping address, contact details, and cart quantities.",
  });
  if (!usPreviewStates.some(([code]) => code === input.data.customer.state)) throw new CommerceError({
    kind: "unavailable", message: `The US preview covers ${usPreviewDeliveryArea}.`,
  });
  return { customer: hybridDemoMode() ? { ...usSampleRecipient, addressLine2: undefined,
    email: demoCheckoutEmail(input.data.customer.email, "demo-order@example.invalid") } : input.data.customer,
    items: [...input.data.items].sort(compareCartItems) };
}

export async function quotePayPalCheckout(db: DbReader, input: PayPalCheckoutInput): Promise<PayPalQuote> {
  const config = paypalSandboxConfig();
  if (!config) throw new CommerceError({ kind: "unavailable", message: "A test shipping rate is required before US checkout can quote an order." });
  const quantities = variantQuantities(input.items);
  const variants = await db.variant.findMany({
    where: { id: { in: [...quantities.keys()] } },
    include: {
      product: { include: { marketplaceShop: { select: marketVisibilitySelect } } }, inventory: true,
      offers: { where: { marketId: "us", currency: "USD", eligible: true } },
    },
  });
  const byVariant = new Map(variants.map(variant => [variant.id, variant]));
  const now = new Date();
  const lines = input.items.map(({ variantId, quantity, personalization }) => {
    const variant = byVariant.get(variantId);
    const product = variant?.product;
    const offer = variant?.offers[0];
    if (!variant?.active || product?.publication !== "ACTIVE" ||
        !(hybridStoreMode() ? merchantProductEligible(product, "us") : !product.demo &&
          (!product.marketplaceShopId || product.marketplaceShopId === storeShop.id)) ||
        !offer || !variant.inventory || variant.inventory.available < (quantities.get(variantId) ?? quantity)) {
      throw new CommerceError({
        kind: "unavailable", message: "Review your cart. Some products or quantities are unavailable for US delivery.",
        issues: product ? [product.name] : undefined,
      });
    }
    const settings = product.personalizationPrompt
      ? { prompt: product.personalizationPrompt, required: product.personalizationRequired }
      : undefined;
    if (!personalizationAvailable(settings, personalization)) throw new CommerceError({
      kind: "unavailable", message: "Review the personalization instructions for your cart.", issues: [product.name],
    });

    const unitDiscountMinor = activeDiscount(offer, now);
    return {
      variantId, sku: variant.sku, productName: product.name, variantName: variant.label, quantity,
      unitPriceMinor: offer.amountMinor, unitDiscountMinor, lineTotalMinor: (offer.amountMinor - unitDiscountMinor) * quantity,
      ...(personalization && { personalization }),
      ...(hybridStoreMode() && product.marketplaceShopId && { marketplaceShopId: product.marketplaceShopId }),
    };
  });

  const subtotalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);
  const merchandiseSubtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
  const shippingMinor = config.shippingMinor;
  const totalMinor = merchandiseSubtotalMinor + shippingMinor;
  if (totalMinor < 1 || subtotalMinor + shippingMinor > 99_999_999) throw new CommerceError({
    kind: "invalid", message: "This cart falls outside the test payment amount limits. Adjust the cart and try again.",
  });

  return {
    currency: "USD", lines, subtotalMinor, discountMinor: subtotalMinor - merchandiseSubtotalMinor,
    merchandiseSubtotalMinor, shippingMinor, taxMinor: 0, totalMinor, deliveryLabel: "US test shipping",
  };
}

export function paypalQuoteToken(guestKey: string, input: PayPalCheckoutInput, quote: PayPalQuote) {
  return quoteDigest(JSON.stringify({ scope: "paypal-us-test", guestKey, input, quote: storedPayPalQuote.parse(quote) }));
}

export function paypalShippingAddress(customer: PayPalCheckoutInput["customer"]): PayPalAddress {
  return {
    address_line_1: customer.addressLine1, ...(customer.addressLine2 && { address_line_2: customer.addressLine2 }),
    admin_area_2: customer.city, admin_area_1: customer.state, postal_code: customer.postalCode, country_code: customer.country,
  };
}
