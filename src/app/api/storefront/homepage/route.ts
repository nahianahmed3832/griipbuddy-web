import { CatalogApiError, catalogRequest } from "@/lib/catalog/connected-public";
import { homepageReadPayload } from "@/lib/catalog/homepage-layout";
import { marketConfiguration } from "@/lib/market-config";

export function GET(request: Request) {
  const url = new URL(request.url);
  for (const locale of url.searchParams.getAll("locale")) url.searchParams.append("lang", locale);
  url.searchParams.delete("locale");
  return catalogRequest(new Request(url, { headers: request.headers }), (params, { marketId, locale, delivery }) => {
    if (params.size || delivery) throw new CatalogApiError(400, "invalid_query", "Use only a market and supported language for the homepage.");
    return homepageReadPayload({ ...marketConfiguration(marketId), locale });
  });
}
