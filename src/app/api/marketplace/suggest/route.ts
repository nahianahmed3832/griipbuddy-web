import { catalogBrowseHref, catalogProductHref } from "@/lib/catalog/category-browse-links";
import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { catalogRequest, CatalogApiError, catalogVariantWhere } from "@/lib/catalog/connected-public";
import { readSearchQuery } from "@/lib/catalog/search-query";
import { getDb } from "@/lib/db/client";
import { catalogSearchKey } from "@/lib/catalog/search-match";
import { searchShops } from "@/lib/marketplace/data";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export function GET(request: Request) {
  return catalogRequest(request, async (params, { marketId, locale }) => {
    const supplied = params.getAll("q");
    if (supplied.length > 1 || [...params.keys()].some(key => key !== "q")) {
      throw new CatalogApiError(400, "invalid_query", "Supply one search query.");
    }
    const query = readSearchQuery(supplied[0]);
    if (query === null) throw new CatalogApiError(400, "invalid_query", "Supply a valid search query.");
    if (query.length < 2) return { marketId, locale, products: [], categories: [], models: [], keywords: [], shops: [] };

    const context = { id: marketId, locale, regional: hybridDemoMode() };
    const [results, shops] = await Promise.all([
      listConnectedCatalog(new URLSearchParams({ q: query, limit: "6" }), { marketId, locale }, undefined, undefined,
        { search: true, suggest: true }),
      marketplaceMode() && !firstPartyStoreMode() ? searchShops(query, marketId) : [],
    ]);
    const products = results.items.map(card => {
      const { amountMinor, eligible: offerEligible, id: offerId } = card.representative.offer;
      const priceQualifier = offerEligible && !card.matchedVariantId && card.matchingVariantIds.length > 1
        ? card.fromPrice?.amountMinor === amountMinor && card.fromPrice.maxAmountMinor > amountMinor
          ? "from" : "shown_option"
        : undefined;
      return { id: card.id, name: card.name, slug: card.slug,
        href: catalogProductHref(card, context), variantId: card.matchedVariantId, offerId: offerEligible && card.matchedVariantId ? offerId : null,
        image: card.representative.image, amountMinor, offerEligible, priceQualifier, currency: results.currency, match: card.searchMatch,
      };
    });
    const categories = (results.suggestions?.categories ?? []).map(({ id, localizedSlug, name }) => ({ id, name,
      href: catalogBrowseHref(`/departments/${encodeURIComponent(localizedSlug)}`, context),
    }));
    const models = (results.suggestions?.models ?? []).map(({ id, name }) => ({ id, name,
      href: catalogBrowseHref("/search", context, new URLSearchParams({ q: name, model: id })),
    }));
    const source = products.length ? await getDb().product.findMany({
      where: { id: { in: products.map(product => product.id) }, variants: { some: catalogVariantWhere(marketId) } },
      select: { keywords: true }, orderBy: { id: "asc" },
    }) : [];
    const term = catalogSearchKey(query);
    const entries = new Map<string, string>();
    for (const { keywords } of source) for (const keyword of keywords) {
      const label = readSearchQuery(keyword);
      const key = label && catalogSearchKey(label);
      if (label && key && term && key !== term && key.startsWith(term) && !entries.has(key)) entries.set(key, label);
    }
    const keywords = [...entries].slice(0, 3).map(([id, name]) => ({ id, name,
      href: catalogBrowseHref("/search", context, new URLSearchParams({ q: name })),
    }));
    return { marketId, locale, products, categories, models, keywords, shops: shops.slice(0, 3).map(({ id, name, slug }) => ({ id, name, slug })) };
  });
}
