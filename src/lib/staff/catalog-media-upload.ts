import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { getDb } from "@/lib/db/client";
import { developmentAcceptanceDatabase, localDatabase } from "@/lib/db/local";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { storeCatalogImage, uploadLimit } from "@/lib/staff/catalog-media";
import { CatalogWriteError, OperationError } from "@/lib/staff/operation-error";

export function productMediaUploadAvailable() {
  return localDatabase() !== null || developmentAcceptanceDatabase();
}

export async function requireMainAdminMediaStorage() {
  if (localDatabase()) return;
  if (developmentAcceptanceDatabase()) {
    const [target] = await getDb().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (target?.name === "griipbuddy_marketplace_dev" && target.role === "griipbuddy_marketplace") return;
  }
  throw new CatalogWriteError("forbidden", "Uploads require the isolated Marketplace catalog media store.");
}

export async function handleCatalogImageUpload(request: Request, uploadAvailable = true) {
  const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return fail("Use the product editor to upload images.", 403);
  if (!uploadAvailable) return fail("Uploads require verified isolated catalog media storage.", 403);
  try {
    const staff = await getStaff();
    if (staff?.role !== "OWNER") return fail("Owner access is required.", 403);
    if (!await consumeQuota("image.upload", staff.id, 50, 600)) return fail("Too many uploads. Try again in a few minutes.", 429);
    const data = await readBody(request, uploadLimit);
    if (!data) return fail("Upload a still JPEG, PNG, or WebP image up to 4 MB.", 413);
    const src = await storeCatalogImage(staff.id, data, request.headers.get("content-type") ?? "");
    return Response.json({ src }, { status: 201, headers: privateHeaders });
  } catch (error) {
    if (error instanceof OperationError) return fail(error.message, 422);
    reportFailure("media.upload", undefined, error);
    return fail("The upload could not be saved. Try again.", 503);
  }
}
