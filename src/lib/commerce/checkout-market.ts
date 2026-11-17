import { MAX_QUANTITY } from "../cart/model.ts";
import type { CartCatalogItem } from "../catalog/types.ts";

export type DirectCheckoutPreview = {
  variantId: string;
  slug: string | null;
  name: string | null;
  variantLabel: string | null;
  quantity: number;
  unitMinor: number | null;
  stock: number | null;
  reason: "not-found" | "not-sold" | "out-of-stock" | "over-stock" | "invalid-quantity" | null;
};

export function previewDirectCheckout(
  variantId: string, quantity: number, item: CartCatalogItem | undefined, alternate: CartCatalogItem | undefined,
): DirectCheckoutPreview {
  const product = item ?? alternate;
  const offer = item?.offer;
  let reason: DirectCheckoutPreview["reason"] = null;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) reason = "invalid-quantity";
  else if (!product) reason = "not-found";
  else if (!offer) reason = "not-sold";
  else if (offer.stock <= 0) reason = "out-of-stock";
  else if (offer.stock < quantity) reason = "over-stock";

  return {
    variantId,
    slug: product?.slug ?? null,
    name: product?.name ?? null,
    variantLabel: product?.variantLabel ?? null,
    quantity,
    unitMinor: offer?.amountMinor ?? null,
    stock: offer?.stock ?? null,
    reason,
  };
}
