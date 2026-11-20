import { connectedCollectionDetail } from "@/lib/catalog/connected-navigation";
import { CatalogApiError, catalogRequest } from "@/lib/catalog/connected-public";

export function GET(request: Request, route: { params: Promise<{ collection: string }> }) {
  return catalogRequest(request, async (params, context) => {
    if (params.size) throw new CatalogApiError(400, "invalid_query", "Unsupported collection query parameter.");
    const { collection } = await route.params;
    const detail = await connectedCollectionDetail(collection, context);
    if (!detail) throw new CatalogApiError(404, "collection_not_found", "Collection not found.");
    return detail;
  });
}
