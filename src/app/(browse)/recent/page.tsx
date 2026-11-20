import type { Metadata } from "next";
import { Breadcrumbs, EmptyState } from "@/components/store-ui";
import { RecentDirectory } from "@/components/marketplace/recent-directory";
import { recommendationConfig } from "@/lib/catalog/recommendation-config";
import { currentMarket } from "@/lib/market-server";

export const metadata: Metadata = { title: "Recently viewed", robots: { index: false, follow: true } };

export default async function RecentPage() {
  const market = await currentMarket();
  const config = await recommendationConfig(market.id, market.locale);
  return <div className="shell inner-page">
    <Breadcrumbs items={[{ label: "Recently viewed" }]} />
    <h1 className="display-type">Recently viewed</h1>
    {config.behavioralEnabled && config.placements.continue.enabled
      ? <RecentDirectory market={market} />
      : <EmptyState title="Browsing history is unavailable" description="Recently viewed items are currently disabled for this market." />}
  </div>;
}
