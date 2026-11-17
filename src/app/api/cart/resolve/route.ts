import { catalog } from "@/lib/catalog/repository";
import { MAX_CART_LINES, validVariantId } from "@/lib/cart/model";
import { currentMarket, storefrontMarketAllowed } from "@/lib/market-server";
import { hybridDemoMode } from "@/lib/release-config";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store" };
  const body: unknown = await request.json().catch(() => null);
  const ids = body && typeof body === "object" && "variantIds" in body ? body.variantIds : null;
  const requestedMarket = body && typeof body === "object" && "marketId" in body ? body.marketId : undefined;
  if (!Array.isArray(ids) || ids.length > MAX_CART_LINES || !ids.every(validVariantId)) {
    return Response.json({ message: "Invalid cart items." }, { status: 400, headers });
  }
  if (requestedMarket !== undefined && (!hybridDemoMode() || !storefrontMarketAllowed(requestedMarket))) {
    return Response.json({ message: "Invalid shopping market." }, { status: 400, headers });
  }
  const marketId = storefrontMarketAllowed(requestedMarket) ? requestedMarket : (await currentMarket()).id;
  const items = await catalog.resolveVariants([...new Set<string>(ids)], marketId);
  return Response.json({ marketId, items }, { headers });
}
