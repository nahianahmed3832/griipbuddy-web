import { productLandingPath } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import { refreshBangladeshMerchantItems } from "./live-bangladesh-feed.ts";
import { collectMerchantFeed, type MerchantFeedItem, type MerchantFeedSettings } from "./merchant-feed.ts";
import type { CatalogProduct } from "./types.ts";

const variantId = "v-6a2160b7c91498b77bdeb4e0";
const productId = "p-6a2160b7c91498b77bdeb4de";
const slug = "memo-cx08-magnetic-phone-cooler-15w-99a742";
const image = { src: "/catalog/memo-cx08-15w-bd-merchant-v1.png", alt: "MEMO CX08 15 W magnetic phone cooler" };

export function merchantBdPreviewRobotsPaths() {
  const exact = productLandingPath(slug, "bd", true, variantId);
  return [exact, exact.split("?")[0], image.src];
}

export function isMerchantBdPreviewProduct(product: CatalogProduct) {
  return product.id === productId && product.slug === slug && product.variants.some(variant => variant.id === variantId);
}

export function merchantBdPreviewPhoto(product: CatalogProduct): CatalogProduct {
  if (!isMerchantBdPreviewProduct(product)) return product;
  return {
    ...product,
    images: [image],
    variants: product.variants.map(variant => variant.id === variantId ? { ...variant, image } : variant),
  };
}

export async function refreshDevBangladeshMerchantItems(items: readonly MerchantFeedItem[], fetchRequest: typeof fetch = fetch) {
  const live = await refreshBangladeshMerchantItems(items, fetchRequest);
  const localPreview = items.find(item => item.productId === productId && item.variantId === variantId && item.currency === "BDT");
  if (!localPreview) return live;

  const unavailableVariantIds = [...live.unavailableVariantIds];
  const matched = live.items.flatMap(item => {
    if (item.variantId !== variantId) return [item];
    // The dev checkout uses local inventory and price. Suppress the preview if it could create an inconsistent order.
    if (item.stock !== localPreview.stock || (item.stock > 0 && item.amountMinor !== localPreview.amountMinor)) {
      unavailableVariantIds.push(variantId);
      return [];
    }
    return [{ ...item, link: localPreview.link, imageLink: new URL(storefrontPath(image.src), localPreview.link).href }];
  });
  return { items: matched, unavailableVariantIds };
}

export async function merchantBdPreviewPageProduct(product: CatalogProduct, settings: MerchantFeedSettings): Promise<CatalogProduct> {
  if (settings.marketId !== "bd" || !isMerchantBdPreviewProduct(product)) return product;
  const prepared = merchantBdPreviewPhoto(product);
  const { items } = collectMerchantFeed([prepared], settings);
  const result = await refreshDevBangladeshMerchantItems(items).catch(() => null);
  const refreshed = result?.items.find(item => item.variantId === variantId);
  const variants = prepared.variants.map(variant => {
    if (variant.id !== variantId || !variant.offer) return variant;
    return { ...variant, offer: {
      ...variant.offer, amountMinor: refreshed?.amountMinor ?? variant.offer.amountMinor,
      stock: refreshed?.stock ?? 0, regularMinor: undefined, promotion: undefined,
    } };
  });
  return { ...prepared, variants };
}
