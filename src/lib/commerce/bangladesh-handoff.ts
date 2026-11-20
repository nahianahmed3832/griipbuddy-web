import { MAX_CART_LINES } from "../cart/model.ts";
import { catalog } from "../catalog/repository.ts";
import type { MarketId } from "../../config/markets.ts";
import { marketConfiguration } from "../market-config.ts";
import { configuredPayment } from "./market-commerce.ts";

export const bangladeshCheckoutUrl = "https://griipbuddy.com/bd/checkout";
export const bangladeshTrackingUrl = "https://griipbuddy.com/track";

export function usesBangladeshCheckout(marketId: MarketId = "bd") {
  return marketConfiguration(marketId).checkoutAuthority === "legacy-handoff" &&
    process.env.COMMERCE_MODE === "production" && process.env.BD_CHECKOUT_HANDOFF === "1";
}

export function bangladeshCheckoutEnabled(marketId: MarketId = "bd") {
  return usesBangladeshCheckout(marketId) && Boolean(configuredPayment(marketId, "COD")) && process.env.ORDER_INTAKE_OPEN === "1";
}

export async function resolveBangladeshHandoff(raw: unknown, marketId: MarketId = "bd") {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_CART_LINES) return [];
  const seen = new Set<string>();
  const items: { variantId: string; quantity: number }[] = [];
  for (const item of raw) {
    if (!item || item.personalization !== undefined || typeof item.variantId !== "string" || !/^v-[a-f0-9]{24}$/.test(item.variantId) ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 5 || seen.has(item.variantId)) return [];
    seen.add(item.variantId);
    items.push({ variantId: item.variantId, quantity: item.quantity });
  }
  const resolved = await catalog.resolveVariants(items.map(({ variantId }) => variantId), marketId);
  const catalogByVariant = new Map(resolved.map(item => [item.variantId, item]));
  const lines = [];
  for (const { variantId, quantity } of items) {
    const item = catalogByVariant.get(variantId);
    const productId = item?.productId?.match(/^p-([a-f0-9]{24})$/)?.[1];
    if (!productId || !item?.offer || item.offer.stock < quantity) return [];
    lines.push({ productId, variantId: variantId.slice(2), quantity });
  }
  return lines;
}
