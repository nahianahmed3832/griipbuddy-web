import { connectedCategoryDetail } from "@/lib/catalog/connected-navigation";
import { CatalogApiError, catalogRequest } from "@/lib/catalog/connected-public";

export function GET(request: Request, route: { params: Promise<{ category: string }> }) {
  return catalogRequest(request, async (params, context) => {
    if (params.size) throw new CatalogApiError(400, "invalid_query", "Unsupported category query parameter.");
    const { category } = await route.params;
    const detail = await connectedCategoryDetail(category, context);
    if (!detail) throw new CatalogApiError(404, "category_not_found", "Category not found.");
    return detail;
  });
}
