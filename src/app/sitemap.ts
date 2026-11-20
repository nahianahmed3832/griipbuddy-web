import type { MetadataRoute } from "next";
import { catalogSitemapPaths, sitemapMarkets } from "@/lib/catalog/catalog-seo";
import { getDb } from "@/lib/db/client";
import { canonicalUrl } from "@/lib/release-config";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const markets = sitemapMarkets();
  if (!markets.length) return [];
  const catalog = await catalogSitemapPaths(getDb(), markets);
  const paths = ["/", "/shop", "/help/delivery", "/help/returns", "/help/privacy", "/help/terms", ...catalog];
  const unique = [...new Set(paths)];
  if (unique.length > 50_000) throw new Error("Catalog sitemap exceeds the URL limit. Partition it before release.");
  return unique.map(path => ({ url: canonicalUrl(path)! }));
}
