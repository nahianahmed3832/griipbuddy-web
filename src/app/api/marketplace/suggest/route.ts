import { catalogBrowseHref, catalogProductHref } from "@/lib/catalog/category-browse-links";
import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { catalogRequest, CatalogApiError } from "@/lib/catalog/connected-public";
import { searchShops } from "@/lib/marketplace/data";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export function GET(request: Request) {
  return catalogRequest(request, async (params, { marketId, locale }) => {
    const supplied = params.getAll("q");
    if (supplied.length > 1 || [...params.keys()].some(key => key !== "q")) {
      throw new CatalogApiError(400, "invalid_query", "Supply one search query.");
    }
    const query = supplied[0]?.trim() ?? "";
    if (query.length < 2) return { marketId, locale, products: [], categories: [], models: [], shops: [] };

    const context = { id: marketId, locale, regional: hybridDemoMode() };
    const [results, shops] = await Promise.all([
      listConnectedCatalog(new URLSearchParams({ q: query, limit: "6" }), { marketId, locale }, undefined, undefined,
        { search: true, suggest: true }),
      marketplaceMode() && !firstPartyStoreMode() ? searchShops(query, marketId) : [],
    ]);
    const products = results.items.map(card => {
      const amountMinor = card.representative.offer.amountMinor;
      const priceQualifier = !card.matchedVariantId && card.matchingVariantIds.length > 1
        ? card.fromPrice?.amountMinor === amountMinor && card.fromPrice.maxAmountMinor > amountMinor
          ? "from" : "shown_option"
        : undefined;
      return { id: card.id, name: card.name, slug: card.slug,
        href: catalogProductHref(card, context), variantId: card.matchedVariantId, offerId: card.representative.offer.id,
        image: card.representative.image, amountMinor, priceQualifier, currency: results.currency, match: card.searchMatch,
      };
    });
    const categories = (results.suggestions?.categories ?? []).map(({ id, localizedSlug, name }) => ({ id, name,
      href: catalogBrowseHref(`/departments/${encodeURIComponent(localizedSlug)}`, context),
    }));
    const models = (results.suggestions?.models ?? []).map(({ id, name }) => ({ id, name,
      href: catalogBrowseHref("/search", context, new URLSearchParams({ q: name, model: id })),
    }));
    return { marketId, locale, products, categories, models, shops: shops.slice(0, 3).map(({ id, name, slug }) => ({ id, name, slug })) };
  });
}
