import { connectedMarketMenu } from "@/lib/catalog/connected-navigation";
import { CatalogApiError, catalogRequest } from "@/lib/catalog/connected-public";
import { slugField } from "@/lib/staff/catalog-input";

export function GET(request: Request) {
  return catalogRequest(request, async (params, context) => {
    const keys = params.getAll("key");
    const key = slugField.safeParse(keys[0] ?? "main");
    if (keys.length > 1 || params.size !== keys.length || !key.success) {
      throw new CatalogApiError(400, "invalid_query", "Provide one valid menu key.");
    }
    const menu = await connectedMarketMenu(key.data, context);
    if (!menu) throw new CatalogApiError(404, "menu_not_found", "Menu not found.");
    return menu;
  });
}
