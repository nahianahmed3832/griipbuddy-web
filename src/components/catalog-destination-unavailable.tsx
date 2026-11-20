import Link from "next/link";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode } from "@/lib/release-config";
import { EmptyState } from "./store-ui";

export async function CatalogDestinationUnavailable({ destination }: { destination: "Category" | "Collection" | "Product" }) {
  const { id, locale, name } = await currentMarket();
  const shop = catalogBrowseHref("/shop", { id, locale, regional: hybridDemoMode() });
  return <div className="shell inner-page">
    <EmptyState heading="h1" title={`${destination} unavailable`} description={`Browse the products and categories available in ${name}.`}>
      <Link className="button button--primary" href={shop} prefetch={false}>Browse products</Link>
    </EmptyState>
  </div>;
}
