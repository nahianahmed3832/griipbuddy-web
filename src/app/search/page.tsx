import type { Metadata } from "next";
import Link from "next/link";
import { ListingPage } from "@/components/listing-page";
import { marketStoreHref } from "@/config/regional-path";
import { readQuery, type SearchParams } from "@/lib/catalog/listing";
import { catalog } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { searchShops } from "@/lib/marketplace/data";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [market, departments, params] = await Promise.all([currentMarket(), catalog.listDepartments(), searchParams]);
  const query = readQuery(params);
  const regionalMarket = hybridDemoMode() ? market.id : undefined;
  const [products, shops] = query ? await Promise.all([
    catalog.listProducts({ marketId: market.id, search: query, leadImageOnly: true }), marketplaceMode() && !firstPartyStoreMode() ? searchShops(query, market.id) : [],
  ]) : [[], []];
  return (
    <>
    {shops.length > 0 && <div className="shell mp-search-shops"><strong>Matching shops</strong>{shops.slice(0, 4).map(shop =>
      <Link href={marketStoreHref(`/shops/${shop.slug}`, regionalMarket)} key={shop.id}>{shop.name}</Link>)}
      <Link href={marketStoreHref(`/shops?q=${encodeURIComponent(query)}`, regionalMarket)}>See all shops</Link>
    </div>}
    <ListingPage
      path="/search"
      title={query ? `Results for “${query}”` : "Search the store"}
      {...{ market, departments, products, params, query }}
    />
    </>
  );
}
