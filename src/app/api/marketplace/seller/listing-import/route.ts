import { marketForStorefrontOrigin, resolveMarketScope } from "@/lib/market-config";
import { exchangeLimit } from "@/lib/catalog/csv-exchange";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { shopperActor } from "@/lib/marketplace/auth";
import { importSellerListings, sellerListingTemplate } from "@/lib/marketplace/listing-import";
import { ListingReviewError } from "@/lib/marketplace/listing-review";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";
import { CatalogWriteError } from "@/lib/staff/operation-error";

const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });

export async function GET(request: Request) {
  if (!marketplaceMode() || firstPartyStoreMode()) return fail("Seller import is unavailable.", 404);
  if (!await shopperActor(request.headers)) return fail("Sign in to download the template.", 401);
  return new Response(sellerListingTemplate, { headers: { ...privateHeaders,
    "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="griipbuddy-seller-listings.csv"' } });
}

export async function POST(request: Request) {
  if (!marketplaceMode() || firstPartyStoreMode()) return fail("Seller import is unavailable.", 404);
  if (!sameOrigin(request)) return fail("Open the import from your shop workspace.", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/csv") return fail("Choose a CSV file.", 415);
  const url = new URL(request.url);
  const requested = url.searchParams.getAll("market");
  const market = requested.length === 1 ? resolveMarketScope(requested[0]) : null;
  const pinned = marketForStorefrontOrigin(url.origin);
  if (!market || (pinned && pinned !== market.id)) return fail("Choose the configured market for this workspace.", 403);
  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return fail("Sign in to import listings.", 401);
    if (!await consumeQuota("catalog.seller-import", shopper.id, 25, 600)) return fail("Too many requests. Wait a few minutes.", 429);
    const raw = await readBody(request, exchangeLimit);
    if (!raw) return fail("Choose a UTF-8 CSV up to 128 KB.", 413);
    let csv: string;
    try { csv = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
    catch { return fail("Save the CSV file as UTF-8 and retry.", 422); }
    const result = await importSellerListings(shopper.id, market.id, csv, request.headers.get("x-import-confirmation") ?? undefined);
    return Response.json(result, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof ListingReviewError || error instanceof CatalogWriteError) return fail(error.message, error.status);
    reportFailure("catalog.seller-import", undefined, error);
    return fail("The import did not finish. Preview your file again.", 503);
  }
}
