import { catalogProductHref } from "@/lib/catalog/category-browse-links";
import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { catalogRequest, CatalogApiError } from "@/lib/catalog/connected-public";
import { recommendationProductId } from "@/lib/catalog/recommendation-policy";
import { hybridDemoMode } from "@/lib/release-config";

export function GET(request: Request) {
  return catalogRequest(request, async (params, { marketId, locale }) => {
    const ids = params.getAll("product");
    if (ids.length > 12 || [...params.keys()].some(key => key !== "product")
      || ids.some(id => !recommendationProductId.safeParse(id).success)) {
      throw new CatalogApiError(400, "invalid_products", "Choose up to twelve products.");
    }
    if (!ids.length) return { items: [] };
    const unique = [...new Set(ids)];
    const data = await listConnectedCatalog(new URLSearchParams({ limit: String(unique.length) }), { marketId, locale }, undefined, undefined,
      { productIds: unique });
    const byId = new Map(data.items.filter(item => item.representative.offer.eligible).map(item => [item.id, item]));
    return { items: unique.flatMap(id => {
      const item = byId.get(id);
      if (!item) return [];
      return [{ id: item.id, name: item.name, image: item.representative.image, priceMinor: item.representative.offer.amountMinor,
        currency: item.representative.offer.currency,
        href: catalogProductHref(item, { id: marketId, locale, regional: hybridDemoMode() }) }];
    }) };
  });
}
