import { z } from "zod";
import { isMarketId } from "@/config/markets";
import { localDatabase } from "@/lib/db/local";
import { privateHeaders } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { isMarketSelectable, marketForStorefrontOrigin } from "@/lib/market-config";
import { getShopperFromHeaders } from "@/lib/marketplace/auth";
import { mobileOrders, type MobileOrdersInput } from "@/lib/mobile/orders";

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };

export async function GET(request: Request, context: { params: Promise<{ audience: string }> }) {
  const error = (status: number, message: string) => Response.json({ version: 1, error: message }, { status, headers });
  const { audience } = await context.params;
  if (localDatabase() !== "griipbuddy_test" || process.env.GRIIP_M11_MOBILE_API !== "1" ||
      audience !== "customer" && audience !== "seller") return error(404, "Mobile orders are unavailable.");
  if (request.headers.get("sec-fetch-site") === "cross-site") return error(403, "Open orders from the storefront.");
  const url = new URL(request.url);
  const markets = url.searchParams.getAll("market");
  const pages = url.searchParams.getAll("page");
  const shops = url.searchParams.getAll("shop");
  const marketId = markets[0];
  const pinned = marketForStorefrontOrigin(url.origin);
  const page = Number(pages[0] ?? 1);
  if (markets.length !== 1 || !isMarketId(marketId) || !isMarketSelectable(marketId) || pinned && pinned !== marketId ||
      pages.length > 1 || !Number.isInteger(page) || page < 1 || page > 50) return error(400, "Choose one market and a valid page.");
  const shop = z.uuid().safeParse(shops[0]);
  if (audience === "seller" ? shops.length !== 1 || !shop.success : shops.length > 0) return error(400, "Choose the authorized scope.");
  try {
    const principal = await getShopperFromHeaders(request.headers);
    if (!principal) return error(401, "Sign in to open orders.");
    if (!await consumeQuota("mobile.orders.v1", principal.id, 60, 60)) return error(429, "Wait before refreshing orders.");
    const input: MobileOrdersInput = audience === "seller" && shop.success ? { audience, marketId, page, shopId: shop.data }
      : { audience: "customer", marketId, page };
    const orders = await mobileOrders(principal.id, input);
    return orders ? Response.json(orders, { headers }) : error(404, "Mobile orders are unavailable in this scope.");
  } catch (cause) {
    reportFailure("mobile.orders.v1", undefined, cause);
    return error(503, "Orders are temporarily unavailable.");
  }
}
