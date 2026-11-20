import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { SellerScaffold } from "@/components/marketplace/seller-scaffold";
import { TaxonomyPendingChanges } from "@/components/taxonomy-controls";
import { selectableMarkets } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { sellerMarketAccess, sellerWorkspace } from "@/lib/marketplace/seller-workspace";
import { sellerNavigationShop } from "@/lib/marketplace/seller-access";
import { marketplaceMode } from "@/lib/release-config";
import "./seller-workspace.css";

export default async function SellerLayout({ children }: { children: ReactNode }) {
  if (!marketplaceMode()) notFound();
  const [{ shop: owned, shopper }, market] = await Promise.all([sellerWorkspace(), currentMarket()]);
  const delegated = !owned && shopper ? await sellerNavigationShop(shopper.id, market.id) : null;
  const shop = owned ?? delegated;
  if (!shop) return children;
  const options = selectableMarkets().map(option => {
    const grant = shop.marketGrants.find(record => record.marketId === option.id);
    const access = sellerMarketAccess(shop.published, grant?.status);
    return { id: option.id, name: option.name, currency: option.currency, access: access.label, tone: access.tone };
  });
  if (!options.length) return children;
  return <Suspense fallback={<div className="seller-entry" role="status">Loading seller workspace…</div>}>
    <TaxonomyPendingChanges>
      <SellerScaffold shopName={shop.name} initialMarket={market.id} options={options} permissions={delegated?.permissions}>{children}</SellerScaffold>
    </TaxonomyPendingChanges>
  </Suspense>;
}
