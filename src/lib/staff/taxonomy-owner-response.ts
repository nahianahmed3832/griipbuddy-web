import { privateHeaders } from "../db/http";
import { reportFailure } from "../db/observability";
import { getStaff } from "./access";
import { CatalogWriteError } from "./operation-error";

export async function taxonomyOwnerResponse(read: (actorId: string) => Promise<unknown>) {
  const send = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });
  try {
    const staff = await getStaff();
    if (!staff) return send({ error: { code: "authentication_required", message: "Sign in to open the catalog workspace." } }, 401);
    if (staff.role !== "OWNER") return send({ error: { code: "forbidden", message: "Central owner access is required." } }, 403);
    return send(await read(staff.id));
  } catch (error) {
    if (error instanceof CatalogWriteError) return send({ error: { code: error.code, message: error.message, fields: error.fields } }, error.status);
    reportFailure("catalog.taxonomy.read", undefined, error);
    return send({ error: { code: "unavailable", message: "The catalog could not be loaded. Try again." } }, 503);
  }
}
