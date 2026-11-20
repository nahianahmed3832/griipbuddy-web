import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { shopperActor } from "@/lib/marketplace/auth";
import { ListingReviewError, storeSellerListingImage } from "@/lib/marketplace/listing-review";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";
import { uploadLimit } from "@/lib/staff/catalog-media";
import { OperationError } from "@/lib/staff/operation-error";

export async function POST(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode() || firstPartyStoreMode()) return reject("Seller listing review is unavailable.", 404);
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403);
  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return reject("Sign in to continue.", 401);
    if (!await consumeQuota("marketplace.seller-listing-image", shopper.id, 30, 3600)) {
      return reject("Too many image uploads. Try again later.", 429);
    }
    const marketId = (await currentMarket()).id;
    const markets = new URL(request.url).searchParams.getAll("marketId");
    if (markets.length !== 1 || markets[0] !== marketId) return reject("Open this action in the selected market.", 403);
    const data = await readBody(request, uploadLimit);
    if (!data) return reject("Choose a JPEG, PNG, or WebP image up to 4 MB.", 400);
    const result = await storeSellerListingImage(shopper.id, marketId, data, request.headers.get("content-type") ?? "");
    return Response.json({ data: result }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof ListingReviewError) return reject(error.message, error.status);
    if (error instanceof OperationError) return reject(error.message, 422);
    reportFailure("marketplace.seller-listing-image", undefined, error);
    return reject("We couldn't save this image. Try again.", 503);
  }
}
