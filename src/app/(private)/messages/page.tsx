import Link from "next/link";
import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { threadsFor } from "@/lib/marketplace/data";
import { sellerBuyerThreads } from "@/lib/marketplace/buyer-support";
import { currentMarket } from "@/lib/market-server";
import { ThreadLinks } from "@/components/marketplace/messages";
import { AccountPanel, AccountWorkspace } from "@/components/marketplace/account-workspace";
import { StartSupportRequest } from "@/components/marketplace/support-request";
import { storeShop } from "@/lib/marketplace/constants";
import { SignInGate } from "@/components/marketplace/session";

export const metadata = { title: "Messages", robots: { index: false, follow: false } };

export default async function MessagesPage({ searchParams }: {
  searchParams: Promise<{ seller?: string | string[]; market?: string | string[]; shop?: string | string[] }>;
}) {
  if (!marketplaceMode()) notFound();
  const [shopper, market, query] = await Promise.all([getShopper(), currentMarket(), searchParams]);
  if (query.market !== undefined && query.market !== market.id || Array.isArray(query.shop) ||
    query.seller !== undefined && query.seller !== "1") notFound();
  if (shopper && query.seller === "1") {
    const inbox = await sellerBuyerThreads(shopper.id, market.id, query.shop);
    if (!inbox) notFound();
    return <div className="shell mp-page">
      <p className="mp-panel-links"><Link href={`/seller/hub?market=${market.id}&shop=${inbox.shop.id}`}>Back to Seller Hub</Link></p>
      <h1 className="mp-page-title">Buyer conversations</h1>
      <p className="mp-lead">{inbox.shop.name} · {market.name}</p>
      <ThreadLinks rows={inbox.rows} market={market.id}/>
    </div>;
  }
  if (!shopper) return <AccountWorkspace title="Messages" market={market}>
    <SignInGate>Sign in to see your conversations.</SignInGate>
  </AccountWorkspace>;
  const rows = await threadsFor({ shopperId: shopper.id }, market.id);
  return <AccountWorkspace title="Messages" description="Follow support replies and private shop conversations." market={market} active="/messages">
    <AccountPanel title="GriipBuddy support">
      <StartSupportRequest/>
      <ThreadLinks rows={rows.filter(row => row.shop.id === storeShop.id)}/>
    </AccountPanel>
    <AccountPanel title="Shop conversations">
      <ThreadLinks rows={rows.filter(row => row.shop.id !== storeShop.id)}/>
    </AccountPanel>
  </AccountWorkspace>;
}
