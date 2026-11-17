import { catalog } from "@/lib/catalog/repository";
import { searchDevice } from "@/lib/catalog/search";
import { readQuery, toSearchCard } from "@/lib/catalog/listing";
import { privateHeaders } from "@/lib/db/http";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { currentMarket, storefrontMarketAllowed } from "@/lib/market-server";
import { suggestShops } from "@/lib/marketplace/data";

export async function GET(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  const params = new URL(request.url).searchParams;
  const query = readQuery({ q: params.get("q") ?? undefined });
  if (query.length < 2) return Response.json({ products: [], shops: [] }, { headers: privateHeaders });
  const hintedMarket = params.get("market");
  if (hintedMarket !== null && !storefrontMarketAllowed(hintedMarket)) return new Response(null, { status: 404, headers: privateHeaders });
  const marketId = hybridDemoMode() && hintedMarket !== null ? hintedMarket : (await currentMarket()).id;
  const [matches, shops] = await Promise.all([
    catalog.listProducts({ marketId, search: query, limit: 6, leadImageOnly: true }),
    firstPartyStoreMode() ? [] : suggestShops(query, marketId),
  ]);
  const fit = searchDevice(query);
  const products = matches.map(product => {
    const { id, name, slug } = product;
    const variantId = fit && toSearchCard(product, fit)?.variantId;
    return { id, name, slug, ...(variantId && { variantId }) };
  });
  return Response.json({ products, shops }, { headers: privateHeaders });
}
