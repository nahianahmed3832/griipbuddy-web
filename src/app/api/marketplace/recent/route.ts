import { productCards } from "@/lib/catalog/listing";
import { catalog } from "@/lib/catalog/repository";
import { privateHeaders } from "@/lib/db/http";
import { currentMarket, storefrontMarketAllowed } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export async function GET(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  const params = new URL(request.url).searchParams;
  const ids = params.getAll("id");
  if (ids.length > 12 || ids.some(id => !id.length || id.length > 128)) {
    return Response.json({ cards: [] }, { status: 400, headers: privateHeaders });
  }
  const region = params.get("market");
  if (region !== null && !storefrontMarketAllowed(region)) return new Response(null, { status: 404, headers: privateHeaders });
  const marketId = hybridDemoMode() && region !== null ? region : (await currentMarket()).id;
  const products = ids.length ? await catalog.listProducts({ marketId, productIds: ids, leadImageOnly: true }) : [];
  const cardsById = new Map(productCards(products).map(card => [card.id, card]));
  const cards = [...new Set(ids)].flatMap(id => cardsById.get(id) ?? []).slice(0, 6);
  return Response.json({ cards }, { headers: privateHeaders });
}
