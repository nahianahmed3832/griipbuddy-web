import type { Market } from "../../config/markets.ts";
import type { CartCatalogItem } from "../catalog/types.ts";
import { personalizationAvailable, personalizationText } from "../catalog/personalization.ts";

export const MAX_CART_LINES = 60;
export const MAX_QUANTITY = 99;
export const CART_STORAGE_KEY = "griipbuddy:storefront:cart:v1";
export type CartItem = { variantId: string; quantity: number; personalization?: string };

export function cartItemKey({ variantId, personalization }: Pick<CartItem, "variantId" | "personalization">): string {
  return personalization ? `${variantId}:${personalization}` : variantId;
}

export function compareCartItems(a: CartItem, b: CartItem): number {
  const variantOrder = a.variantId.localeCompare(b.variantId);
  if (variantOrder) return variantOrder;
  const first = a.personalization ?? "";
  const second = b.personalization ?? "";
  return first < second ? -1 : first > second ? 1 : 0;
}

export function variantQuantities(items: readonly CartItem[]) {
  const quantities = new Map<string, number>();
  for (const { variantId, quantity } of items) {
    quantities.set(variantId, (quantities.get(variantId) ?? 0) + quantity);
  }
  return quantities;
}

export function validVariantId(value: unknown): value is string {
  return typeof value === "string" && /^v-[a-z0-9-]{1,79}$/.test(value);
}

export function decodeCart(raw: string | null): readonly CartItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const data = parsed && typeof parsed === "object" && "items" in parsed ? parsed.items : parsed;
    if (!Array.isArray(data)) return [];
    const items = new Map<string, CartItem>();
    const quantities = new Map<string, number>();
    for (const entry of data.slice(0, MAX_CART_LINES)) {
      if (!entry || !validVariantId(entry.variantId) || !Number.isInteger(entry.quantity) || entry.quantity < 1) continue;
      const personalization = personalizationText(entry.personalization);
      if (entry.personalization !== undefined && !personalization) continue;
      const existing = quantities.get(entry.variantId) ?? 0;
      const quantity = Math.min(MAX_QUANTITY - existing, entry.quantity);
      if (quantity < 1) continue;
      const item = { variantId: entry.variantId, quantity, ...(personalization && { personalization }) };
      const key = cartItemKey(item);
      item.quantity += items.get(key)?.quantity ?? 0;
      items.set(key, item);
      quantities.set(entry.variantId, existing + quantity);
    }
    return [...items.values()];
  } catch {
    return [];
  }
}

export function cartCount(items: readonly CartItem[]): number {
  return items.reduce((total, item) => total + item.quantity, 0);
}

export function addToItems(items: readonly CartItem[], variantId: string, quantity: number, stock: number, personalization?: string): readonly CartItem[] | null {
  if (!validVariantId(variantId) || !Number.isInteger(quantity) || quantity < 1) return null;
  const note = personalizationText(personalization);
  if (personalization !== undefined && !note) return null;
  const item = { variantId, quantity, ...(note && { personalization: note }) };
  const key = cartItemKey(item);
  const existing = items.some(line => cartItemKey(line) === key);
  if ((variantQuantities(items).get(variantId) ?? 0) + quantity > Math.min(MAX_QUANTITY, stock)) return null;
  if (existing) return items.map(line => cartItemKey(line) === key ? { ...line, quantity: line.quantity + quantity } : line);
  if (items.length >= MAX_CART_LINES) return null;
  return [...items, item];
}

export function updateItems(items: readonly CartItem[], variantId: string, quantity: number, stock: number, personalization?: string): readonly CartItem[] {
  const key = cartItemKey({ variantId, personalization });
  const line = items.find(item => cartItemKey(item) === key);
  if (!line || !Number.isInteger(quantity) || quantity < 1) return items;
  const otherQuantity = (variantQuantities(items).get(variantId) ?? 0) - line.quantity;
  if (otherQuantity + quantity > Math.min(stock, MAX_QUANTITY)) return items;
  return items.map(item => cartItemKey(item) === key ? { ...item, quantity } : item);
}

export type CartLineStatus = "available" | "not-sold" | "out-of-stock" | "over-stock" | "removed" | "personalization";

export function cartLineIssue(status: CartLineStatus, marketName: string): string | null {
  switch (status) {
    case "not-sold": return `Unavailable in ${marketName}`;
    case "out-of-stock": return `Out of stock in ${marketName}`;
    case "removed": return "This item is no longer in the catalog";
    case "over-stock": return `Reduce the quantity for ${marketName}`;
    case "personalization": return "Review the listing’s personalization instructions and add the item again.";
    default: return null;
  }
}

export function evaluateCart(items: readonly CartItem[], catalog: readonly CartCatalogItem[], market: Market) {
  const byId = new Map(catalog.map((entry) => [entry.variantId, entry]));
  const quantities = variantQuantities(items);
  const lines = items.map((item) => {
    const product = byId.get(item.variantId);
    const offer = product?.offer?.marketId === market.id && product.offer.currency === market.currency ? product.offer : null;
    const variantStock = Math.min(offer?.stock ?? 0, MAX_QUANTITY);
    const otherQuantity = (quantities.get(item.variantId) ?? 0) - item.quantity;
    const stock = Math.max(0, variantStock - otherQuantity);
    let status: CartLineStatus = "available";
    if (!product) status = "removed";
    else if (!offer) status = "not-sold";
    else if (!personalizationAvailable(product.personalization, item.personalization)) status = "personalization";
    else if (!variantStock) status = "out-of-stock";
    else if (item.quantity > stock) status = "over-stock";
    return {
      ...item, product, stock, variantStock, status,
      unitMinor: offer?.amountMinor ?? null,
      lineMinor: status === "available" && offer ? offer.amountMinor * item.quantity : null,
    };
  });
  return {
    lines,
    subtotalMinor: lines.reduce((total, line) => total + (line.lineMinor ?? 0), 0),
    affectedLines: lines.filter((line) => line.status !== "available").length,
    eligibleQuantity: lines.reduce((total, line) => total + (line.status === "available" ? line.quantity : 0), 0),
  };
}
