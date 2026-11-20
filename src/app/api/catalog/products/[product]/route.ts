import { getConnectedProduct, productSelection } from "@/lib/catalog/connected-product";
import { catalogRequest, CatalogApiError } from "@/lib/catalog/connected-public";

export function GET(request: Request, { params }: { params: Promise<{ product: string }> }) {
  return catalogRequest(request, async (query, context) => {
    const { product } = await params;
    const result = await getConnectedProduct(product, context, productSelection(query));
    if (!result) throw new CatalogApiError(404, "product_not_found", "This product is unavailable in the selected market.");
    return result;
  });
}
