import Link from "next/link";
import { EmptyState } from "@/components/store-ui";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode } from "@/lib/release-config";

export default async function CatalogDestinationUnavailable() {
  const { id, locale } = await currentMarket();
  const browse = catalogBrowseHref("/shop", { id, locale, regional: hybridDemoMode() }, new URLSearchParams({ catalogUnavailable: "collection" }));
  return <div className="shell inner-page">
    <EmptyState title="Collection unavailable" description="Browse the products and categories available in your selected market.">
      <Link className="button button--primary" href={browse}>Browse this market</Link>
    </EmptyState>
  </div>;
}
