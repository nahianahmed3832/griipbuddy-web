import type { MetadataRoute } from "next";
import { defaultMarketId } from "@/config/markets";
import { catalog } from "@/lib/catalog/repository";
import { canonicalUrl, productionMode } from "@/lib/release-config";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!productionMode()) return [];
  const [departments, collections, products] = await Promise.all([
    catalog.listDepartments(), catalog.listCollections(), catalog.listProducts({ marketId: defaultMarketId }),
  ]);
  return [
    "/", "/shop", "/help/delivery", "/help/returns", "/help/privacy", "/help/terms",
    ...departments.map(({ slug }) => `/departments/${slug}`),
    ...collections.map(({ slug }) => `/collections/${slug}`),
    ...products.map(({ slug }) => `/products/${slug}`),
  ].map((path) => ({ url: canonicalUrl(path)! }));
}
