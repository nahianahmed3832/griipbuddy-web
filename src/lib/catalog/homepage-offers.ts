import type { Market } from "../../config/markets.ts";
import type { HomepageSection } from "./homepage-contract.ts";
import { discountPercentage, productCards } from "./listing.ts";
import type { CatalogProduct } from "./types.ts";

export function eligibleHomeProducts<T extends CatalogProduct>(products: readonly T[], market: Pick<Market, "id" | "currency">) {
  return products.flatMap(product => {
    const variants = product.variants.filter(({ offer }) => offer && offer.marketId === market.id &&
      offer.currency === market.currency && offer.stock > 0 && Number.isSafeInteger(offer.amountMinor) && offer.amountMinor >= 0);
    return variants.length ? [{ ...product, variants }] : [];
  });
}

export function homepageDealCards(products: readonly CatalogProduct[], currency: Market["currency"], budget?: HomepageSection["budget"]) {
  if (budget && budget.currency !== currency) return [];
  const cards = productCards(products.map(product => ({
    ...product,
    variants: product.variants.filter(({ offer }) => offer?.stock && offer.currency === currency && (budget
      ? offer.amountMinor <= budget.amountMinor
      : offer.promotion && offer.regularMinor !== undefined && offer.amountMinor < offer.regularMinor)),
  })));
  return cards.sort((a, b) => budget ? a.priceMinor - b.priceMinor : discountPercentage(b) - discountPercentage(a));
}
