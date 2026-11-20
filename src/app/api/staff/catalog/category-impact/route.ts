import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { CatalogWriteError } from "@/lib/staff/operation-error";
import { readCategoryImpact } from "@/lib/staff/taxonomy-impact";

export async function GET(request: Request) {
  const errorResponse = (status: number, code: string, message: string) =>
    Response.json({ error: { code, message } }, { status, headers: privateHeaders });
  try {
    const staff = await getStaff();
    if (!staff) return errorResponse(401, "authentication_required", "Sign in to review category impact.");
    if (staff.role !== "OWNER") return errorResponse(403, "forbidden", "Central owner access is required.");
    const params = new URL(request.url).searchParams;
    const ids = params.getAll("categoryId");
    if (ids.length !== 1 || params.size !== 1) return errorResponse(400, "invalid_input", "Specify one category ID.");
    const data = await readCategoryImpact(staff.id, ids[0]);
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof CatalogWriteError) return errorResponse(error.status, error.code, error.message);
    reportFailure("taxonomy.impact", undefined, error);
    return errorResponse(503, "unavailable", "The category impact could not be loaded. Try again.");
  }
}
