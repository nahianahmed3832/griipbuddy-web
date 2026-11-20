import Link from "next/link";
import { Gift } from "lucide-react";
import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";
import { catalog } from "@/lib/catalog/repository";
import { ListingPage } from "@/components/listing-page";
import type { SearchParams } from "@/lib/catalog/listing";

export const metadata = { title: "Gift ideas" };

export default async function GiftsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!marketplaceMode()) notFound();
  const [market, params] = await Promise.all([currentMarket(), searchParams]);
  const [departments, products] = await Promise.all([catalog.listDepartments(market.id), catalog.listProducts({ marketId: market.id })]);
  return <>
    <div className="shell mp-page mp-shop-page">
      <section className="mp-registry-hero">
        <Gift size={34} aria-hidden="true"/><h1 className="mp-page-title">Find something they’ll love</h1>
        <p>Browse gifts by price or by what they’re into.</p>
        <div className="mp-panel-links">{market.merchandising.giftBudgets.map(amount => <Link key={amount} className="button button--outline"
          href={`/gifts?max=${amount}&availability=in-stock`}>Under {market.currency} {amount.toLocaleString(market.locale)}</Link>)}
          <Link className="button button--primary" href="/registry">Gift Registry</Link></div>
      </section>
    </div>
    <ListingPage title="Gift ideas" path="/gifts" {...{ products, departments, market, params }}/>
  </>;
}
