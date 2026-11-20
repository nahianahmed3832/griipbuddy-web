import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { runAdminHubCommand, SellerHubError } from "@/lib/marketplace/seller-hub";
import { workspaceRequestMarket } from "@/lib/marketplace/workspace-request";
import { marketplaceMode } from "@/lib/release-config";
import { getStaffFromHeaders } from "@/lib/staff/access";

export async function POST(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode()) return reject("Seller Hub is unavailable.", 404);
  if (!sameOrigin(request)) return reject("Open this action from the staff workspace.", 403);
  try {
    const market = workspaceRequestMarket(request.url);
    if (!market) return reject("Choose a configured market.", 400);
    const staff = await getStaffFromHeaders(request.headers);
    if (!staff || staff.role !== "OWNER") return reject("Owner access is required.", 403);
    if (!await consumeQuota("staff.seller-hub.write", staff.id, 60, 600)) return reject("Too many updates. Try again shortly.", 429);
    const data = await runAdminHubCommand(staff, market, await readJson(request, 15_000));
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof SellerHubError) return reject(error.message, error.status);
    reportFailure("staff.seller-hub.write", undefined, error);
    return reject("The operation could not be confirmed.", 503);
  }
}
