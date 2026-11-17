import type { Metadata } from "next";
import { ListingPage } from "@/components/listing-page";
import type { SearchParams } from "@/lib/catalog/listing";
import { catalog } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl } from "@/lib/release-config";

export function generateMetadata(): Metadata {
  return { title: "Shop all", alternates: { canonical: canonicalUrl("/shop") } };
}

export default async function ShopPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [market, departments, params] = await Promise.all([currentMarket(), catalog.listDepartments(), searchParams]);
  const products = await catalog.listProducts({ marketId: market.id, leadImageOnly: true });
  return <ListingPage path="/shop" title="Shop all" {...{ market, departments, products, params }} />;
}
