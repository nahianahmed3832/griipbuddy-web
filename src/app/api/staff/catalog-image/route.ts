import { handleCatalogImageUpload } from "@/lib/staff/catalog-media-upload";

export function POST(request: Request) {
  return handleCatalogImageUpload(request);
}
