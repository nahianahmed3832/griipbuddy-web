import { revalidatePath } from "next/cache";
import { invalidateHomepagePublication } from "@/lib/catalog/homepage-cache";
import { handleMainAdminCatalog } from "@/lib/catalog/main-admin-api";

export function POST(request: Request) {
  return handleMainAdminCatalog(request, () => revalidatePath("/", "layout"), invalidateHomepagePublication);
}
