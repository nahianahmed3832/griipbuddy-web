import { connectedCategoryTree } from "@/lib/catalog/connected-navigation";
import { CatalogApiError, catalogRequest } from "@/lib/catalog/connected-public";

export function GET(request: Request) {
  return catalogRequest(request, async (params, context) => {
    if (params.size) throw new CatalogApiError(400, "invalid_query", "Unsupported category query parameter.");
    return connectedCategoryTree(context);
  });
}
