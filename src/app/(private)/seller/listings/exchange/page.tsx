import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SellerListingImportForm } from "@/components/marketplace/seller-listing-import-form";
import { SellerEmpty, SellerPageHeader } from "@/components/marketplace/seller-ui";
import { SignInGate } from "@/components/marketplace/session";
import { currentMarket } from "@/lib/market-server";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";
import { sellerWorkspace } from "@/lib/marketplace/seller-workspace";

export const metadata = { title: "Import seller listings" };

export default async function SellerListingExchangePage() {
  if (!marketplaceMode() || firstPartyStoreMode()) notFound();
  const [{ shopper, shop }, market] = await Promise.all([sellerWorkspace(), currentMarket()]);
  if (!shopper) return <SignInGate>Sign in to import shop listings.</SignInGate>;
  if (!shop) redirect("/seller");
  const allowed = shop.published && shop.marketGrants.some(grant => grant.marketId === market.id && grant.status === "APPROVED");
  return <>
    <SellerPageHeader title="Import listings" description={`${shop.name} · ${market.name} · ${market.currency}`} actions={
      <Link className="seller-button" href={`/seller/listings?market=${market.id}`}>Back to products</Link>}/>
    <section className="seller-panel">
      {allowed ? <SellerListingImportForm key={market.id} marketId={market.id}/> :
        <SellerEmpty title="Trading approval is required">Manage market access before importing listings here.</SellerEmpty>}
    </section>
  </>;
}
