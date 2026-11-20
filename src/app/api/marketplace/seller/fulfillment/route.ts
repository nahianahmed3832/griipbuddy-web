import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { advanceSellerPreparation, SellerOrderError } from "@/lib/marketplace/seller-orders";
import { marketplaceMode } from "@/lib/release-config";

export async function POST(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode()) return new Response(null, { status: 404, headers: privateHeaders });
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403);

  try {
    const shopper = await getShopper();
    if (!shopper) return reject("Sign in to continue.", 401);
    if (!await consumeQuota("marketplace.seller-preparation", shopper.id, 90, 300)) {
      return reject("Too many actions. Try again shortly.", 429);
    }
    const data = await advanceSellerPreparation(shopper.id, await readJson(request, 1024));
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof SellerOrderError) return reject(error.message, error.status);
    reportFailure("marketplace.seller-preparation", undefined, error);
    return reject("We couldn't update this order. Try again.", 503);
  }
}
