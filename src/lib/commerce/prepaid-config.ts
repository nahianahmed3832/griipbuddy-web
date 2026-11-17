import { isOperatingDatabase } from "../db/local.ts";
import { marketplaceMode, orderIntakeOpen } from "../release-config.ts";

export function prepaidConfig() {
  if (!marketplaceMode() || !isOperatingDatabase()) return null;
  const storeId = process.env.MARKETPLACE_SSLCOMMERZ_STORE_ID?.trim();
  const password = process.env.MARKETPLACE_SSLCOMMERZ_STORE_PASSWORD?.trim();
  const origin = process.env.BETTER_AUTH_URL?.trim();
  if (!storeId || !password || !origin) return null;
  return { storeId, password, origin };
}

export function prepaidAvailable() {
  return Boolean(prepaidConfig()) && orderIntakeOpen();
}
