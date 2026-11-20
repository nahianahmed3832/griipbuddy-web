import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { catalogRequest, CatalogApiError } from "@/lib/catalog/connected-public";

export function GET(request: Request) {
  return catalogRequest(request, (params, context) => {
    const pages = params.getAll("page");
    if (pages.length > 1 || pages.length && (!/^[1-9]\d{0,4}$/.test(pages[0]) || params.has("cursor"))) {
      throw new CatalogApiError(400, "invalid_page", "Use one page number or cursor.");
    }
    params.delete("page");
    const browsePage = pages.length ? Number(pages[0]) : undefined;
    return listConnectedCatalog(params, context, undefined, undefined, { search: true, browsePage });
  });
}
