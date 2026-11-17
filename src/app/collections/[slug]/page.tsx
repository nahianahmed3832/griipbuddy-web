import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ListingPage } from "@/components/listing-page";
import type { SearchParams } from "@/lib/catalog/listing";
import { catalog } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl } from "@/lib/release-config";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const collection = await catalog.getCollection((await params).slug);
  return { title: collection?.name ?? "Collection not found", description: collection?.description, alternates: collection ? { canonical: canonicalUrl(`/collections/${collection.slug}`) } : undefined };
}

export default async function CollectionPage({ params, searchParams }: Props) {
  const [{ slug }, market, departments, filters] = await Promise.all([params, currentMarket(), catalog.listDepartments(), searchParams]);
  const collection = await catalog.getCollection(slug);
  if (!collection) notFound();
  const products = await catalog.listProducts({ marketId: market.id, collectionId: collection.id, leadImageOnly: true });
  return <ListingPage path={`/collections/${slug}`} title={collection.name} description={collection.description} params={filters} newest={collection.selection === "new"} {...{ market, departments, products }} />;
}
