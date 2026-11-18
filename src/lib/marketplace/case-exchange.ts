import type { Prisma } from "../../generated/prisma/client.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { mayRequestExchange } from "./case-policy.ts";
import { storeShop } from "./constants.ts";
import { merchantProductEligibility } from "./market-grants.ts";

export const exchangeSource = { id: true, variantId: true, personalization: true, marketplaceShopId: true } as const;
export type ExchangeSource = Prisma.OrderItemGetPayload<{ select: typeof exchangeSource }>;
export type ExchangeVariant = { id: string; label: string; sku: string; available: number };

function variantOptions(value: Prisma.JsonValue) {
  const options = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return options;
  for (const [key, option] of Object.entries(value)) {
    if (typeof option !== "string" || !option.trim()) continue;
    const name = key.trim().toLowerCase();
    options.set(name === "colour" ? "color" : name, option.trim().toLowerCase());
  }
  return options;
}

function changesSizeOrColor(original: Map<string, string>, replacement: Map<string, string>) {
  if (original.size !== replacement.size) return false;
  let changed = false;
  for (const [key, value] of original) {
    const next = replacement.get(key);
    if (next === value) continue;
    if (!next || (key !== "color" && key !== "size")) return false;
    changed = true;
  }
  return changed;
}

export async function eligibleExchangeVariants(db: DbReader, sources: readonly ExchangeSource[]) {
  const byItem = new Map<string, ExchangeVariant[]>();
  const items = sources.filter(item => !item.personalization);
  if (!items.length) return byItem;
  const originalIds = [...new Set(items.map(item => item.variantId))];
  const offer = { marketId: "bd", currency: "BDT", eligible: true } as const;
  const products = await db.product.findMany({
    where: { ...merchantProductEligibility("bd"), publication: "ACTIVE", personalizationRequired: false,
      variants: { some: { id: { in: originalIds } } } },
    select: { marketplaceShopId: true, variants: {
      where: { OR: [{ id: { in: originalIds } }, { active: true, offers: { some: offer } }] },
      orderBy: [{ position: "asc" }, { id: "asc" }], select: {
        id: true, label: true, sku: true, active: true, options: true, inventory: { select: { available: true } },
        offers: { where: offer, select: { amountMinor: true, discountMinor: true, discountStartsAt: true, discountEndsAt: true } },
      },
    } },
  });
  const originalIdSet = new Set(originalIds);
  const productByVariant = new Map(products.flatMap(product => product.variants
    .filter(variant => originalIdSet.has(variant.id)).map(variant => [variant.id, product] as const)));
  const now = new Date();
  for (const item of items) {
    const product = productByVariant.get(item.variantId);
    if (!product || (product.marketplaceShopId ?? storeShop.id) !== (item.marketplaceShopId ?? storeShop.id)) continue;
    const original = product.variants.find(variant => variant.id === item.variantId);
    const originalOffer = original?.offers[0];
    if (!original || !originalOffer) continue;
    const originalOptions = variantOptions(original.options);
    const price = originalOffer.amountMinor - activeDiscount(originalOffer, now);
    byItem.set(item.id, product.variants.flatMap(variant => {
      const variantOffer = variant.offers[0];
      const available = variant.inventory?.available ?? 0;
      if (!variant.active || variant.id === item.variantId || !variantOffer || available <= 0 ||
          variantOffer.amountMinor - activeDiscount(variantOffer, now) !== price ||
          !changesSizeOrColor(originalOptions, variantOptions(variant.options))) return [];
      return [{ id: variant.id, label: variant.label, sku: variant.sku, available }];
    }));
  }
  return byItem;
}

export async function exchangeVariantsForPurchase(orderId: string, shopperId: string, itemIds: readonly string[]) {
  if (!itemIds.length) return new Map<string, ExchangeVariant[]>();
  const db = getDb();
  const order = await db.order.findFirst({
    where: { id: orderId, shopperId, marketId: "bd" },
    select: { marketId: true, status: true, fulfillmentStatus: true, returnTerms: true,
      items: { where: { id: { in: [...itemIds] } }, select: exchangeSource } },
  });
  return order && mayRequestExchange(order) ? eligibleExchangeVariants(db, order.items) : new Map<string, ExchangeVariant[]>();
}
