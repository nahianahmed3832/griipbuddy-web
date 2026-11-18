import { videoUploadLimit } from "@/lib/catalog/video";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { storeCatalogVideo, videoUploadMessage } from "@/lib/staff/catalog-video";
import { OperationError } from "@/lib/staff/operations";

export async function POST(request: Request) {
  const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return fail("Use the product editor to upload videos.", 403);
  try {
    const staff = await getStaff();
    if (staff?.role !== "OWNER") return fail("Owner access is required.", 403);
    if (!await consumeQuota("video.upload", staff.id, 20, 600)) return fail("Too many uploads. Try again in a few minutes.", 429);
    const data = await readBody(request, videoUploadLimit);
    if (!data) return fail(videoUploadMessage, 413);
    const src = await storeCatalogVideo(staff.id, data, request.headers.get("content-type") ?? "");
    return Response.json({ src }, { status: 201, headers: privateHeaders });
  } catch (error) {
    if (error instanceof OperationError) return fail(error.message, 422);
    reportFailure("video.upload", undefined, error);
    return fail("The upload could not be saved. Try again.", 503);
  }
}
