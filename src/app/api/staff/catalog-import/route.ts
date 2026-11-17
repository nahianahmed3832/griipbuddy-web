import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/staff/access";
import { applyImport, csvLimit, previewImport } from "@/lib/staff/catalog-import";
import { OperationError } from "@/lib/staff/operations";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";

export async function POST(request: Request) {
  const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return fail("Use the owner dashboard to import a catalog.", 403);
  try {
    const staff = await getStaff();
    if (staff?.role !== "OWNER") return fail("Owner access is required.", 403);
    if (!await consumeQuota("catalog.import", staff.id, 20, 300)) return fail("Too many import requests. Wait a few minutes.", 429);
    const raw = await readBody(request, csvLimit);
    if (!raw) return fail("Choose a UTF-8 CSV file up to 256 KB.", 413);
    let csv: string;
    try {
      csv = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return fail("Save the CSV file as UTF-8 and try again.", 422);
    }
    const token = request.headers.get("x-import-confirmation");
    if (token === null) {
      const preview = await previewImport(staff.id, csv);
      return Response.json({ preview }, { headers: privateHeaders });
    }
    const results = await applyImport(staff.id, csv, token);
    revalidatePath("/", "layout");
    return Response.json({ results }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof OperationError) return fail(error.message, 409);
    reportFailure("staff.catalog-import", undefined, error);
    return fail("The import request could not be completed. Preview the file again to see what was saved.", 503);
  }
}
