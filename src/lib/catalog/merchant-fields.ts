import type { MarketId } from "../../config/markets.ts";
import { productLandingPath } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import { validGtin } from "./identifiers.ts";
import type { CatalogProduct, ListedVariant } from "./types.ts";

type MerchantDimension = "color" | "size" | "material" | "pattern";
const dimensions = new Map<string, MerchantDimension>([
  ["color", "color"], ["colour", "color"], ["size", "size"], ["material", "material"], ["pattern", "pattern"],
]);

export function merchantDimension(name: string) {
  return dimensions.get(name.trim().toLowerCase());
}

export function merchantVariantDetails(product: CatalogProduct, variant: ListedVariant) {
  const options: Partial<Record<MerchantDimension, string>> = {};
  for (const [name, value] of Object.entries(variant.options)) {
    const key = merchantDimension(name);
    if (key && value.trim()) options[key] ??= value.trim();
  }
  const gtin = variant.gtin?.trim();
  return { brand: product.brand?.trim() || undefined, gtin: validGtin(gtin) ? gtin : undefined,
    mpn: variant.mpn?.trim() || undefined, ...options };
}

export function merchantProductUrl(origin: string, slug: string, market: MarketId, regional: boolean, variantId?: string) {
  return new URL(storefrontPath(productLandingPath(slug, market, regional, variantId)), origin).href;
}
