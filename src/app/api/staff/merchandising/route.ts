import { getStaff } from "@/lib/staff/access";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { consumeQuota } from "@/lib/db/observability";
import { handleMerchandising } from "@/lib/staff/merchandising-http";
import { merchandisingEnabled } from "@/lib/staff/merchandising-config";

const send = (data: object, status = 200) => Response.json(data, { status, headers: privateHeaders });

export async function POST(request: Request) {
  if (!merchandisingEnabled()) return send({ error: "Merchandising is unavailable." }, 404);
  if (!sameOrigin(request) || request.headers.get("x-griip-merchandising") !== "1") return send({ error: "Use the merchandising workspace." }, 403);
  const staff = await getStaff();
  if (staff?.role !== "OWNER") return send({ error: "Owner access is required." }, 403);
  if (!await consumeQuota("merchandising.write", staff.id, 100, 600)) return send({ error: "Too many changes. Try again in a few minutes." }, 429);
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;")) return send({ error: "Use the merchandising form." }, 415);
  const body = await readBody(request, 450_000);
  if (!body) return send({ error: "The submission exceeds the file limit." }, 413);
  let form: FormData;
  try { form = await new Response(new Uint8Array(body), { headers: request.headers }).formData(); }
  catch { return send({ error: "The form could not be read." }, 422); }
  const result = await handleMerchandising(staff.id, form);
  return send(result, result.error ? 422 : 200);
}
