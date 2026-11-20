import type { CartCatalogItem } from "../catalog/types.ts";
import { cartOfferKey, type CartItemReference } from "./model.ts";

export type ReorderLine = {
  id: string;
  productName: string;
  sku: string;
  quantity: number;
} & (
  { message: string } |
  { reference: CartItemReference; variantId: string; offerId: string; amountMinor: number; personalization?: string }
);

export function reorderCatalogByReference(catalog: readonly CartCatalogItem[]) {
  return new Map(catalog.map(item => [cartOfferKey({
    variantId: item.requestedVariantId ?? item.variantId, offerId: item.requestedOfferId,
  }), item]));
}
