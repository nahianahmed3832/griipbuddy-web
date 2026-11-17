import { isOperatingDatabase } from "../db/local.ts";
import { marketplaceMode, orderIntakeOpen } from "../release-config.ts";

export function paypalSandboxConfig() {
  if (!marketplaceMode() || !isOperatingDatabase()) return null;
  const shipping = process.env.MARKETPLACE_PAYPAL_US_TEST_SHIPPING_MINOR;
  const origin = process.env.BETTER_AUTH_URL;
  if (!shipping || !/^\d{1,7}$/.test(shipping) || !origin) return null;
  return {
    origin,
    shippingMinor: Number(shipping),
    clientId: process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_ID?.trim(),
    clientSecret: process.env.MARKETPLACE_PAYPAL_SANDBOX_CLIENT_SECRET?.trim(),
    webhookId: process.env.MARKETPLACE_PAYPAL_SANDBOX_WEBHOOK_ID?.trim(),
  };
}

export function paypalCheckoutAvailability() {
  const config = paypalSandboxConfig();
  const shippingMinor = config && orderIntakeOpen() ? config.shippingMinor : null;
  const quoteEnabled = shippingMinor !== null;
  return { shippingMinor, quoteEnabled, paymentEnabled: quoteEnabled && Boolean(config?.clientId && config.clientSecret) };
}
