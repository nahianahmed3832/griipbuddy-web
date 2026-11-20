import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { shopperActor } from "@/lib/marketplace/auth";
import { sellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { sellerOrdersCsv, SellerOrderError, sellerOrderWorkspace } from "@/lib/marketplace/seller-orders";
import { marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";
import { isMarketSelectable, marketForStorefrontOrigin } from "@/lib/market-config";

export async function GET(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode()) return new Response(null, { status: 404, headers: privateHeaders });

  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return reject("Sign in to continue.", 401);
    const url = new URL(request.url);
    const query = url.searchParams;
    const requested = query.get("market");
    const bound = marketForStorefrontOrigin(url.origin);
    if (requested !== null && (!isMarketSelectable(requested) || bound && bound !== requested) || query.getAll("market").length > 1) {
      return reject("Choose a configured market.", 400);
    }
    const marketId = isMarketSelectable(requested) ? requested : bound ?? (await currentMarket()).id;
    if (query.getAll("shop").length > 1) return reject("Choose one shop.", 400);
    const seller = await sellerOrderWorkspace(shopper.id, marketId, query.get("shop") ?? undefined);
    if (!seller?.finance) return reject("Shop not found.", 404);
    const range = sellerOrderRange(query.get("from") ?? undefined, query.get("to") ?? undefined, new Date(), marketId);
    if (!range || query.getAll("from").length > 1 || query.getAll("to").length > 1) {
      return reject("Choose a valid date range.", 400);
    }

    const csv = await sellerOrdersCsv(seller.id, range);
    return new Response(csv, {
      headers: {
        ...privateHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="griipbuddy-${marketId}-orders-${range.from}-to-${range.to}.csv"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof SellerOrderError) return reject(error.message, error.status);
    reportFailure("marketplace.seller-orders-export", undefined, error);
    return reject("We couldn't download orders. Try again.", 503);
  }
}
