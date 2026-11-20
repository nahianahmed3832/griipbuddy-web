import type { MarketId } from "../../config/markets.ts";
import { localizedStorePath } from "../../config/regional-path.ts";

export type CatalogBrowseContext = { id: MarketId; locale: string; regional: boolean };

export function catalogBrowseHref(path: string, context: CatalogBrowseContext, query = new URLSearchParams()) {
  const params = new URLSearchParams(query);
  params.set("market", context.id);
  params.set("lang", context.locale);
  return `${context.regional ? localizedStorePath(path, context.id) : path}?${params}`;
}
