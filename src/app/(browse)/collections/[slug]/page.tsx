import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ConnectedCatalogBrowse } from "@/components/connected-catalog-browse";
import type { MarketId } from "@/config/markets";
import { catalogRobots, catalogSeoPath, hasBrowseFilters } from "@/lib/catalog/catalog-seo";
import { connectedCollectionDetail } from "@/lib/catalog/connected-navigation";
import type { SearchParams } from "@/lib/catalog/listing";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl } from "@/lib/release-config";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };
const findCollection = cache((slug: string, marketId: MarketId, locale: string) => connectedCollectionDetail(slug, { marketId, locale }));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ slug }, market, query] = await Promise.all([params, currentMarket(), searchParams]);
  const data = await findCollection(slug, market.id, market.locale);
  if (!data) return { title: "Collection unavailable", robots: { index: false, follow: true } };
  const { collection } = data;
  const robots = catalogRobots(market, hasBrowseFilters(query));
  const canonical = robots?.follow === false ? undefined : canonicalUrl(catalogSeoPath(`/collections/${encodeURIComponent(collection.slug)}`,
    { id: market.id, locale: market.defaultLocale }));
  return { title: collection.name, description: collection.description, robots, alternates: { canonical } };
}

export default async function CollectionPage({ params, searchParams }: Props) {
  const [{ slug }, market, raw] = await Promise.all([params, currentMarket(), searchParams]);
  const data = await findCollection(slug, market.id, market.locale);
  if (!data) notFound();
  return <ConnectedCatalogBrowse destination={{ type: "collection", data: data.collection }} market={market} raw={raw} />;
}
