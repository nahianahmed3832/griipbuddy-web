import Link from "next/link";
import { notFound } from "next/navigation";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { uuid } from "@/lib/commerce/checkout-types";
import { getShopper } from "@/lib/marketplace/auth";
import { savedList } from "@/lib/marketplace/data";
import { savedProductCards } from "@/lib/marketplace/saved-product-cards";
import { currentMarket } from "@/lib/market-server";
import { reportFailure } from "@/lib/db/observability";
import { ProductGrid } from "@/components/product-grid";
import { EditList, OtherSavedProducts, RemoveListItem, SavedProductsRetry } from "@/components/marketplace/lists";

export const metadata = { title: "Saved items", robots: { index: false, follow: false } };

export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!marketplaceMode() || !uuid.safeParse(id).success) notFound();
  const [shopper, market] = await Promise.all([getShopper(), currentMarket()]);
  const list = await savedList(id, shopper?.id);
  if (!list) notFound();
  const owner = shopper?.id === list.shopperId;
  const products = await savedProductCards(list.items.map(item => item.productId), market.id, owner)
    .catch(error => { reportFailure("account.saved-list", undefined, error); return null; });
  const availableCards = products?.filter(item => item.card) ?? [];
  const cards = availableCards.flatMap(item => item.card ?? []);
  const regional = hybridDemoMode();
  return <div className="shell mp-page">
    <p className="mp-panel-links"><Link href={list.registry ? "/registry" : "/favorites"}>{list.registry ? "Registry" : "Collections"}</Link></p>
    <h1 className="mp-page-title">{list.name}</h1>
    {owner && <EditList list={{ id: list.id, name: list.name, public: list.public, registry: list.registry }}/>}
    {products === null && <SavedProductsRetry />}
    {products?.length === 0 && <p>No items in this {list.registry ? "registry" : "collection"} for this shopping region.</p>}
    {cards.length > 0 && <ProductGrid cards={cards} market={market} placement={{ placement: "wishlist" }} savedParents={{ regional }} />}
    {products && <OtherSavedProducts products={products} market={market} regional={regional} list={owner ? id : undefined} />}
    {owner && availableCards.length > 0 && <details className="mp-section"><summary>Remove items</summary>
      <ul className="mp-shop-grid">{availableCards.map(item => <li key={item.id}><RemoveListItem list={id} item={item} market={market}/></li>)}</ul>
    </details>}
  </div>;
}
