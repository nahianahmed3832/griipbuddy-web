import { fixtureFeedExportEnabled, loadFixtureFeedSelection, parseFeedExport, serializeFixtureFeed } from "@/lib/catalog/merchant-feed-export";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { getStaffFromHeaders } from "@/lib/staff/access";
import { canUseMarket } from "@/lib/staff/market-access";

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };
const failure = (status: number, error: string) => Response.json({ error }, { status, headers });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure(403, "Export from the staff catalog.");
  const actor = await getStaffFromHeaders(request.headers);
  if (!actor) return failure(401, "Sign in to export offers.");
  if (actor.role !== "OWNER") return failure(403, "Catalog feed export requires an owner.");
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return failure(400, "Submit a feed selection.");
  const body = await readBody(request, 12_000);
  const selection = body && parseFeedExport(new URLSearchParams(body.toString("utf8")));
  if (!selection) return failure(400, "Select one market, its currency, and up to 50 variants. Meta requires a condition.");
  if (!await canUseMarket(actor.id, selection.marketId, "commercial")) return failure(403, "This market is not assigned.");
  if (!fixtureFeedExportEnabled(selection.marketId)) return failure(409, "A native development market is required for this export.");
  try {
    const feed = await loadFixtureFeedSelection(selection.marketId);
    const xml = serializeFixtureFeed(selection, feed);
    if (!xml) return failure(409, "A selected offer is no longer eligible in this market. Reload the selection.");
    return new Response(xml, { headers: { ...headers,
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="griipbuddy-${selection.marketId}-${selection.channel}.xml"`,
      "X-Content-Type-Options": "nosniff" } });
  } catch {
    return failure(503, "The catalog is temporarily unavailable. Retry from the feed workspace.");
  }
}
