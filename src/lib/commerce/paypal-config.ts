import { isOperatingDatabase } from "../db/local.ts";
import { marketplaceMode, orderIntakeOpen } from "../release-config.ts";
import { configuredPayment, providerMarket } from "./market-commerce.ts";
import { providerAccountKey } from "./provider-payment-account.ts";
import type { MarketId } from "../../config/markets.ts";

export function paypalSandboxConfig(marketId: MarketId | undefined = providerMarket("PAYPAL")) {
  if (!marketId || marketId !== providerMarket("PAYPAL") || !marketplaceMode() || !isOperatingDatabase()) return null;
  const shipping = process.env.MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR;
  const origin = process.env.BETTER_AUTH_URL;
  if (!shipping || !/^\d{1,7}$/.test(shipping) || !origin) return null;
  const merchantId = process.env.MARKETPLACE_PAYPAL_SANDBOX_MERCHANT_ID?.trim();
  return {
    marketId, merchantId, accountKey: merchantId && providerAccountKey("PAYPAL", marketId, merchantId),
    origin,
    shippingMinor: Number(shipping),
    clientId: process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_ID?.trim(),
    clientSecret: process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_SECRET?.trim(),
    webhookId: process.env.MARKETPLACE_PAYPAL_SANDBOX_WEBHOOK_ID?.trim(),
  };
}

export function paypalCheckoutAvailability(marketId: MarketId | undefined = providerMarket("PAYPAL")) {
  const config = paypalSandboxConfig(marketId);
  const quoteEnabled = Boolean(config && configuredPayment(config.marketId, "PAYPAL")) && orderIntakeOpen();
  return { quoteEnabled, paymentEnabled: quoteEnabled && Boolean(config?.clientId && config.clientSecret && config.accountKey) };
}
