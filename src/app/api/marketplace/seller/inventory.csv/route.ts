import { exchangeCsv } from "@/lib/catalog/csv-exchange";
import { privateHeaders } from "@/lib/db/http";
import { marketForStorefrontOrigin, resolveMarketScope } from "@/lib/market-config";
import { shopperActor } from "@/lib/marketplace/auth";
import { readSellerStock, sellerStockFilters, sellerStockStatuses } from "@/lib/marketplace/seller-stock";
import { CatalogWriteError } from "@/lib/staff/operation-error";

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };

export async function GET(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return new Response(null, { status: 403, headers });
  const shopper = await shopperActor(request.headers);
  if (!shopper) return new Response(null, { status: 401, headers });
  const url = new URL(request.url);
  const market = resolveMarketScope(url.searchParams.get("market"));
  const allowed = ["market", "q", "location", "status"];
  const keys = [...url.searchParams.keys()];
  const status = url.searchParams.get("status");
  const invalid = (url.searchParams.get("q")?.length ?? 0) > 100 || (url.searchParams.get("location")?.length ?? 0) > 96 ||
    status !== null && !sellerStockStatuses.some(value => value === status);
  if (!market || invalid || new Set(keys).size !== keys.length || keys.some(key => !allowed.includes(key))) {
    return new Response("Choose one supported market and stock filter.", { status: 400, headers });
  }
  const pinned = marketForStorefrontOrigin(url.origin);
  if (pinned && pinned !== market.id) return new Response(null, { status: 403, headers });
  try {
    const { rows } = await readSellerStock(shopper.id, market.id, sellerStockFilters(name => url.searchParams.get(name) ?? undefined));
    const output = exchangeCsv(["authority", "pool_id", "product_id", "variant_id", "sku", "owner_id", "location_id", "warehouse",
      "view_market", "approved_routes", "on_hand", "reserved", "available", "unavailable_in_view", "threshold", "updated_at"], rows.map(row =>
      ["native-postgres", row.id, row.productId, row.variantId, row.sku, row.ownerId, row.locationId, row.locationName, market.id,
        row.markets.join("|"), row.onHand, row.reserved, row.available, row.unavailable, row.lowStockThreshold, row.updatedAt]));
    return new Response(output, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="seller-stock-${market.id}.csv"` } });
  } catch (error) {
    return new Response(error instanceof CatalogWriteError ? error.message : "Inventory export is unavailable.",
      { status: error instanceof CatalogWriteError ? error.status : 503, headers });
  }
}
