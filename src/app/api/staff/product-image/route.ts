import { retiredCatalogApiResponse } from "@/lib/catalog/main-admin-browser";
import { handleCatalogImageUpload, productMediaUploadAvailable } from "@/lib/staff/catalog-media-upload";

export async function POST(request: Request) {
  return (await retiredCatalogApiResponse(request)) ?? handleCatalogImageUpload(request, productMediaUploadAvailable());
}
