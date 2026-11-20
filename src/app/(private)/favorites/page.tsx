import Link from "next/link";
import { notFound } from "next/navigation";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { shopperSelections } from "@/lib/marketplace/data";
import { savedProductCards } from "@/lib/marketplace/saved-product-cards";
import { currentMarket } from "@/lib/market-server";
import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { CreateList } from "@/components/marketplace/favorites";
import { FavoritesGrid, ListLinks, SavedProductsRetry } from "@/components/marketplace/lists";
import { SignInGate } from "@/components/marketplace/session";

export const metadata = { title: "Favorites", robots: { index: false, follow: false } };

export default async function FavoritesPage() {
  if (!marketplaceMode()) notFound();
  const [shopper, market] = await Promise.all([getShopper(), currentMarket()]);
  const [selections, products] = shopper ? await Promise.all([
    shopperSelections(shopper.id, market.id),
    getDb().shopperFavorite.findMany({ where: { shopperId: shopper.id }, orderBy: { createdAt: "desc" },
      take: 300, select: { productId: true } })
      .then(rows => savedProductCards(rows.map(row => row.productId), market.id, true))
      .catch(error => { reportFailure("account.favorites", undefined, error); return null; }),
  ]) : [null, null];
  return <div className="shell mp-page">
    <h1 className="mp-page-title">Favorites</h1>
    {selections ? <>
      <section className="mp-section"><h2>Favorite items</h2>
        {products ? <FavoritesGrid products={products} market={market} regional={hybridDemoMode()} /> : <SavedProductsRetry />}
      </section>
      <section className="mp-section"><h2>Collections</h2><ListLinks lists={selections.lists.filter(list => !list.registry)}/><CreateList registry={false}/></section>
      <section className="mp-section"><h2>Shops you follow</h2>
        {selections.shops.length ? <ul className="mp-shop-grid">{selections.shops.map(shop => <li key={shop.id}>
          <Link href={`/shops/${shop.slug}`}><strong>{shop.name}</strong></Link>
        </li>)}</ul> : <p>Follow a shop to find it here.</p>}
      </section>
    </> : <SignInGate>Sign in to save items, create collections, and follow shops.</SignInGate>}
  </div>;
}
