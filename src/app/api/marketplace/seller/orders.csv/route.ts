import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { sellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { sellerOrdersCsv, SellerOrderError, sellerShop } from "@/lib/marketplace/seller-orders";
import { marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";
import { isMarketSelectable } from "@/lib/market-config";

export async function GET(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode()) return new Response(null, { status: 404, headers: privateHeaders });

  try {
    const shopper = await getShopper();
    if (!shopper) return reject("Sign in to continue.", 401);
    const shop = await sellerShop(shopper.id);
    if (!shop) return reject("Shop not found.", 404);
    const query = new URL(request.url).searchParams;
    const requested = query.get("market");
    if (requested !== null && !isMarketSelectable(requested) || query.getAll("market").length > 1) {
      return reject("Choose a configured market.", 400);
    }
    const marketId = isMarketSelectable(requested) ? requested : (await currentMarket()).id;
    const range = sellerOrderRange(query.get("from") ?? undefined, query.get("to") ?? undefined, new Date(), marketId);
    if (!range || query.getAll("from").length > 1 || query.getAll("to").length > 1) {
      return reject("Choose a valid date range.", 400);
    }

    const csv = await sellerOrdersCsv(shop.id, range);
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
