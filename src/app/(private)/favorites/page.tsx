import Link from "next/link";
import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { cardsById, shopperSelections } from "@/lib/marketplace/data";
import { currentMarket } from "@/lib/market-server";
import { CreateList } from "@/components/marketplace/favorites";
import { FavoritesGrid, ListLinks } from "@/components/marketplace/lists";
import { SignInGate } from "@/components/marketplace/session";

export const metadata = { title: "Favorites" };

export default async function FavoritesPage() {
  if (!marketplaceMode()) notFound();
  const [shopper, market] = await Promise.all([getShopper(), currentMarket()]);
  const selections = shopper ? await shopperSelections(shopper.id, market.id) : null;
  const cards = selections ? await cardsById(market.id, selections.favorites) : [];
  return <div className="shell mp-page">
    <h1 className="mp-page-title">Favorites</h1>
    {selections ? <>
      <section className="mp-section"><h2>Favorite items</h2><FavoritesGrid cards={cards} market={market}/></section>
      <section className="mp-section"><h2>Collections</h2><ListLinks lists={selections.lists.filter(list => !list.registry)}/><CreateList registry={false}/></section>
      <section className="mp-section"><h2>Shops you follow</h2>
        {selections.shops.length ? <ul className="mp-shop-grid">{selections.shops.map(shop => <li key={shop.id}>
          <Link href={`/shops/${shop.slug}`}><strong>{shop.name}</strong></Link>
        </li>)}</ul> : <p>Follow a shop to find it here.</p>}
      </section>
    </> : <SignInGate>Sign in to save items, create collections, and follow shops.</SignInGate>}
  </div>;
}
