import { connectedCollections } from "@/lib/catalog/connected-navigation";
import { CatalogApiError, catalogRequest } from "@/lib/catalog/connected-public";

export function GET(request: Request) {
  return catalogRequest(request, async (params, context) => {
    if (params.size) throw new CatalogApiError(400, "invalid_query", "Unsupported collection query parameter.");
    return connectedCollections(context);
  });
}
