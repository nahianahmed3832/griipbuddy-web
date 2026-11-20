import { isMarketId } from "@/config/markets";
import { merchantFeedXml } from "@/lib/catalog/merchant-feed";
import { loadMerchantFeed } from "@/lib/catalog/merchant-feed-service";
import { storefrontIndexingEnabled } from "@/lib/release-config";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: RouteContext<"/feeds/[file]">) {
  const { file } = await params;
  const marketId = file.endsWith(".xml") ? file.slice(0, -4) : undefined;
  if (!isMarketId(marketId)) return new Response(null, { status: 404 });

  const headers = new Headers({
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (!storefrontIndexingEnabled()) headers.set("X-Robots-Tag", "noindex, nofollow");
  try {
    const { settings, items } = await loadMerchantFeed(marketId);
    return new Response(merchantFeedXml(items, settings), { headers });
  } catch {
    headers.set("Content-Type", "text/plain; charset=utf-8");
    headers.set("Retry-After", "60");
    return new Response("The catalog feed is temporarily unavailable.", { status: 503, headers });
  }
}
