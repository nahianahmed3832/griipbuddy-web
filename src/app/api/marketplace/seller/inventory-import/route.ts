import { exchangeLimit } from "@/lib/catalog/csv-exchange";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { getDb } from "@/lib/db/client";
import { marketForStorefrontOrigin, resolveMarketScope } from "@/lib/market-config";
import { shopperActor } from "@/lib/marketplace/auth";
import { importSellerStock, sellerStockTemplate } from "@/lib/marketplace/seller-stock-import";
import { sellerStockAccess } from "@/lib/marketplace/seller-stock";
import { CatalogWriteError } from "@/lib/staff/operation-error";

const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });

async function handle(request: Request, write: boolean) {
  if (write && !sameOrigin(request) || request.headers.get("sec-fetch-site") === "cross-site") return fail("Open the inventory workspace.", 403);
  const url = new URL(request.url);
  const market = url.searchParams.size === 1 ? resolveMarketScope(url.searchParams.get("market")) : null;
  const pinned = marketForStorefrontOrigin(url.origin);
  if (!market || pinned && pinned !== market.id) return fail("Choose the warehouse market for this workspace.", 403);
  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return fail("Sign in to manage inventory.", 401);
    if (!write) {
      await sellerStockAccess(getDb(), shopper.id, market.id);
      return new Response(sellerStockTemplate, { headers: { ...privateHeaders, "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="seller-stock-adjustment.csv"' } });
    }
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/csv") return fail("Choose a CSV file.", 415);
    if (!await consumeQuota("inventory.seller-import", shopper.id, 25, 600)) return fail("Too many requests. Wait a few minutes.", 429);
    const data = await readBody(request, exchangeLimit);
    if (!data) return fail("Choose a UTF-8 CSV up to 128 KB.", 413);
    let csv: string;
    try { csv = new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { return fail("Choose a UTF-8 CSV file.", 422); }
    return Response.json(await importSellerStock(shopper.id, market.id, csv, request.headers.get("x-inventory-confirmation") ?? undefined),
      { headers: privateHeaders });
  } catch (error) {
    if (error instanceof CatalogWriteError) return fail(error.message, error.status);
    reportFailure("inventory.seller-import", undefined, error);
    return fail("The file could not be processed. Review the latest balances.", 503);
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
