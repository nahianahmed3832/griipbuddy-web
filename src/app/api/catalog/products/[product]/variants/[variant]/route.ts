import { validVariantId } from "@/lib/cart/model";
import { getExactConnectedVariant } from "@/lib/catalog/connected-product";
import { catalogRequest, CatalogApiError } from "@/lib/catalog/connected-public";
import { expireInventoryReservations } from "@/lib/commerce/inventory-reservations";

export function GET(request: Request, { params }: { params: Promise<{ product: string; variant: string }> }) {
  return catalogRequest(request, async (query, context) => {
    if (query.size) throw new CatalogApiError(400, "invalid_query", "Supply only a market, language or delivery context.");
    const { product, variant } = await params;
    if (context.delivery && validVariantId(variant)) await expireInventoryReservations(new Date(), 20, [variant]);
    const result = await getExactConnectedVariant(product, variant, context);
    if (!result) throw new CatalogApiError(404, "variant_not_found", "This variant is unavailable for this product in the selected market.");
    return result;
  });
}
