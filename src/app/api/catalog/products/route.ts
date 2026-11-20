import { listConnectedCatalog } from "@/lib/catalog/connected-listing";
import { catalogRequest } from "@/lib/catalog/connected-public";

export function GET(request: Request) {
  return catalogRequest(request, listConnectedCatalog);
}
