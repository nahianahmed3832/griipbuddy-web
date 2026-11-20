import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { searchCollectionProducts } from "@/lib/staff/navigation-workspace";
import { CatalogWriteError } from "@/lib/staff/operation-error";

function failure(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers: privateHeaders });
}

export async function GET(request: Request) {
  try {
    const staff = await getStaff();
    if (!staff) return failure(401, "authentication_required", "Sign in to manage collections.");
    if (staff.role !== "OWNER") return failure(403, "forbidden", "Only central owners can edit shared collection assignments.");
    const params = new URL(request.url).searchParams;
    if (new Set(params.keys()).size !== params.size) return failure(400, "invalid_query", "Provide one value per search option.");
    const data = await searchCollectionProducts(staff.id, Object.fromEntries(params));
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof CatalogWriteError) return failure(error.status, error.code, error.message);
    reportFailure("catalog.collection-product-search", undefined, error);
    return failure(503, "unavailable", "Collection product search is temporarily unavailable.");
  }
}
