import { revalidatePath } from "next/cache";
import { invalidateHomepagePublication } from "@/lib/catalog/homepage-cache";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { shopperActor } from "@/lib/marketplace/auth";
import { ListingReviewError, saveSellerListing, sellerListingCommand } from "@/lib/marketplace/listing-review";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";

export async function POST(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode() || firstPartyStoreMode()) return reject("Seller listing review is unavailable.", 404);
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403);
  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return reject("Sign in to continue.", 401);
    if (!await consumeQuota("marketplace.seller-listing", shopper.id, 90, 300)) return reject("Too many actions. Try again shortly.", 429);
    const raw = await readJson(request, 48 * 1024);
    const input = sellerListingCommand.safeParse(raw);
    if (!input.success) return reject(input.error.issues[0].message, 400);
    if (input.data.marketId !== (await currentMarket()).id) return reject("Open this action in the selected market.", 403);
    const data = await saveSellerListing(shopper.id, input.data);
    if (input.data.action === "withdraw") {
      revalidatePath("/", "layout");
      invalidateHomepagePublication();
    }
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof ListingReviewError) return reject(error.message, error.status);
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return reject("A SKU or listing identifier is already in use.", 409);
    }
    reportFailure("marketplace.seller-listing", undefined, error);
    return reject("We couldn't save this listing. Try again.", 503);
  }
}
