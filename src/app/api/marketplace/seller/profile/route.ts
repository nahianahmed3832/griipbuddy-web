import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { shopperActor } from "@/lib/marketplace/auth";
import { saveSellerMarketProfile, SellerProfileError } from "@/lib/marketplace/seller-market-profile";
import { workspaceRequestMarket } from "@/lib/marketplace/workspace-request";
import { marketplaceMode } from "@/lib/release-config";

export async function POST(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode()) return reject("Seller settings are unavailable.", 404);
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403);
  try {
    const market = workspaceRequestMarket(request.url);
    if (!market) return reject("Choose a configured market.", 400);
    const shopper = await shopperActor(request.headers);
    if (!shopper) return reject("Sign in to continue.", 401);
    if (!await consumeQuota("seller.profile.write", shopper.id, 40, 600)) return reject("Too many updates. Try again shortly.", 429);
    const data = await saveSellerMarketProfile(shopper.id, market, await readJson(request, 10_000));
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof SellerProfileError) return reject(error.message, error.status);
    reportFailure("seller.profile.write", undefined, error);
    return reject("The update could not be confirmed.", 503);
  }
}
