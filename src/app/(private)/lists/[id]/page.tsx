import Link from "next/link";
import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { uuid } from "@/lib/commerce/checkout-types";
import { getShopper } from "@/lib/marketplace/auth";
import { cardsById, savedList } from "@/lib/marketplace/data";
import { currentMarket } from "@/lib/market-server";
import { ProductGrid } from "@/components/product-grid";
import { EditList, RemoveListItem } from "@/components/marketplace/lists";

export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!marketplaceMode() || !uuid.safeParse(id).success) notFound();
  const [shopper, market] = await Promise.all([getShopper(), currentMarket()]);
  const list = await savedList(id, shopper?.id);
  if (!list) notFound();
  const owner = shopper?.id === list.shopperId;
  const cards = await cardsById(market.id, list.items.map(item => item.productId));
  return <div className="shell mp-page">
    <p className="mp-panel-links"><Link href={list.registry ? "/registry" : "/favorites"}>{list.registry ? "Registry" : "Collections"}</Link></p>
    <h1 className="mp-page-title">{list.name}</h1>
    {owner && <EditList list={{ id: list.id, name: list.name, public: list.public, registry: list.registry }}/>}
    {cards.length ? <ProductGrid cards={cards} market={market} placement={{ placement: "wishlist" }}/> : <p>No items in this {list.registry ? "registry" : "collection"} for this shopping region.</p>}
    {owner && cards.length > 0 && <details className="mp-section"><summary>Remove items</summary>
      <ul className="mp-shop-grid">{cards.map(item => <li key={item.id}><RemoveListItem list={id} card={item} market={market}/></li>)}</ul>
    </details>}
  </div>;
}
