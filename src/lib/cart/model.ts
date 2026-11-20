import type { Market } from "../../config/markets.ts";
import type { CartCatalogItem } from "../catalog/types.ts";
import { personalizationAvailable, personalizationText } from "../catalog/personalization.ts";

export const MAX_CART_LINES = 60;
export const MAX_QUANTITY = 99;
export const CART_STORAGE_KEY = "griipbuddy:storefront:cart:v1";
export type CartItemReference = { variantId: string; offerId?: string };
export type CartItem = CartItemReference & { quantity: number; personalization?: string };
export type CheckoutCartItem = CartItem & { cartOfferId?: string; cartVariantId?: string };

export function cartOfferKey({ variantId, offerId }: CartItemReference): string {
  return offerId ? `${variantId}~${offerId}` : variantId;
}

export function cartItemKey({ variantId, offerId, personalization }: Omit<CartItem, "quantity">): string {
  const offer = cartOfferKey({ variantId, offerId });
  return personalization ? `${offer}:${personalization}` : offer;
}

export function cartReferences(items: readonly CartItem[]): CartItemReference[] {
  return [...new Map(items.map(({ variantId, offerId }) => {
    const line = { variantId, ...(offerId && { offerId }) };
    return [cartOfferKey(line), line];
  })).values()].sort((a, b) => cartOfferKey(a).localeCompare(cartOfferKey(b)));
}

export function cartLookupBody(items: readonly CartItem[]): string {
  const references = cartReferences(items);
  return JSON.stringify(references.some(line => line.offerId) ? { lines: references } : { variantIds: references.map(line => line.variantId) });
}

export function purchasedCartItem({ variantId, cartVariantId, cartOfferId, quantity, personalization }: CheckoutCartItem): CartItem {
  return { variantId: cartVariantId ?? variantId, quantity,
    ...(personalization && { personalization }), ...(cartOfferId && { offerId: cartOfferId }) };
}

export function compareCartItems(a: CartItem, b: CartItem): number {
  const variantOrder = a.variantId.localeCompare(b.variantId);
  if (variantOrder) return variantOrder;
  const offerOrder = (a.offerId ?? "").localeCompare(b.offerId ?? "");
  if (offerOrder) return offerOrder;
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

export function validCartOfferId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
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
      if (entry.offerId !== undefined && !validCartOfferId(entry.offerId)) continue;
      const existing = quantities.get(entry.variantId) ?? 0;
      const quantity = Math.min(MAX_QUANTITY - existing, entry.quantity);
      if (quantity < 1) continue;
      const item = { variantId: entry.variantId, quantity, ...(personalization && { personalization }),
        ...(entry.offerId && { offerId: entry.offerId }) };
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

export function addToItems(items: readonly CartItem[], variantId: string, quantity: number, stock: number, personalization?: string,
  offerId?: string): readonly CartItem[] | null {
  if (!validVariantId(variantId) || !Number.isInteger(quantity) || quantity < 1 || offerId !== undefined && !validCartOfferId(offerId)) return null;
  const note = personalizationText(personalization);
  if (personalization !== undefined && !note) return null;
  const item = { variantId, quantity, ...(note && { personalization: note }), ...(offerId && { offerId }) };
  const key = cartItemKey(item);
  const existing = items.some(line => cartItemKey(line) === key);
  if ((variantQuantities(items).get(variantId) ?? 0) + quantity > Math.min(MAX_QUANTITY, stock)) return null;
  if (existing) return items.map(line => cartItemKey(line) === key ? { ...line, quantity: line.quantity + quantity } : line);
  if (items.length >= MAX_CART_LINES) return null;
  return [...items, item];
}

export function updateItems(items: readonly CartItem[], variantId: string, quantity: number, stock: number, personalization?: string,
  offerId?: string): readonly CartItem[] {
  const key = cartItemKey({ variantId, personalization, offerId });
  const line = items.find(item => cartItemKey(item) === key);
  if (!line || !Number.isInteger(quantity) || quantity < 1) return items;
  const otherQuantity = (variantQuantities(items).get(variantId) ?? 0) - line.quantity;
  if (otherQuantity + quantity > Math.min(stock, MAX_QUANTITY)) return items;
  return items.map(item => cartItemKey(item) === key ? { ...item, quantity } : item);
}

export type CartLineStatus = "available" | "not-sold" | "out-of-stock" | "over-stock" | "removed" | "personalization" | "offer-changed" | "duplicate-offer";

export function evaluateCart(items: readonly CartItem[], catalog: readonly CartCatalogItem[], market: Market) {
  const byId = new Map(catalog.map(entry => [cartOfferKey({ variantId: entry.requestedVariantId ?? entry.variantId,
    offerId: entry.requestedOfferId }), entry]));
  const resolved = items.map(item => {
    const product = byId.get(cartOfferKey(item));
    const offer = product?.offer?.marketId === market.id && product.offer.currency === market.currency ? product.offer : null;
    return { item, product, offer };
  });
  const quantities = variantQuantities(resolved.flatMap(({ item, product, offer }) => product && offer
    ? [{ ...item, variantId: product.variantId }] : []));
  const duplicates = new Map<string, number>();
  for (const { item, product, offer } of resolved) {
    if (!product || !offer) continue;
    const key = cartItemKey({ ...item, variantId: product.variantId, offerId: offer.id });
    duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
  }
  const lines = resolved.map(({ item, product, offer }) => {
    const variantId = product?.variantId ?? item.variantId;
    const variantStock = Math.min(offer?.stock ?? 0, MAX_QUANTITY);
    const otherQuantity = Math.max(0, (quantities.get(variantId) ?? 0) - item.quantity);
    const stock = Math.max(0, variantStock - otherQuantity);
    let status: CartLineStatus = "available";
    if (!product) status = "removed";
    else if (product.offerIssue === "changed") status = "offer-changed";
    else if (!offer) status = "not-sold";
    else if ((duplicates.get(cartItemKey({ ...item, variantId, offerId: offer.id })) ?? 0) > 1) status = "duplicate-offer";
    else if (!personalizationAvailable(product.personalization, item.personalization)) status = "personalization";
    else if (!variantStock) status = "out-of-stock";
    else if (item.quantity > stock) status = "over-stock";
    return {
      ...item, product, stock, variantStock, status,
      unitMinor: offer?.amountMinor ?? null,
      lineMinor: status === "available" && offer ? offer.amountMinor * item.quantity : null,
    };
  });
  const checkoutItems: CheckoutCartItem[] = lines.flatMap(line => {
    const variantId = line.product?.variantId;
    if (line.status !== "available" || !variantId) return [];
    const offerId = line.product?.offer?.id;
    return [{ variantId, quantity: line.quantity,
      ...(line.personalization && { personalization: line.personalization }),
      ...(offerId && { offerId }),
      ...(line.offerId && { cartOfferId: line.offerId }),
      ...(variantId !== line.variantId && { cartVariantId: line.variantId }),
    }];
  });
  return {
    lines,
    checkoutItems,
    subtotalMinor: lines.reduce((total, line) => total + (line.lineMinor ?? 0), 0),
    affectedLines: lines.filter((line) => line.status !== "available").length,
    eligibleQuantity: lines.reduce((total, line) => total + (line.status === "available" ? line.quantity : 0), 0),
  };
}
