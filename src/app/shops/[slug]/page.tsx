import { notFound } from "next/navigation";
import Form from "next/form";
import { Store } from "lucide-react";
import { marketplaceMode } from "@/lib/release-config";
import { getDb } from "@/lib/db/client";
import { catalog } from "@/lib/catalog/repository";
import { readQuery, type SearchParams } from "@/lib/catalog/listing";
import { currentMarket } from "@/lib/market-server";
import { sellerVisibility } from "@/lib/marketplace/market-grants";
import { ListingPage } from "@/components/listing-page";
import { FollowShop } from "@/components/marketplace/favorites";
import { MessageShop } from "@/components/marketplace/messages";

export const metadata = { title: "Visit shop" };

export default async function PublicShop({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  if (!marketplaceMode()) notFound();
  const { slug } = await params;
  const market = await currentMarket();
  const [shop, departments, filters] = await Promise.all([
    getDb().marketplaceShop.findFirst({ where: { slug, ...sellerVisibility(market.id) }, select: {
      id: true, slug: true, name: true, announcement: true, about: true, _count: { select: { followers: true } },
    } }), catalog.listDepartments(market.id), searchParams,
  ]);
  if (!shop) notFound();
  const query = readQuery(filters);
  const path = `/shops/${shop.slug}`;
  const products = await catalog.listProducts({ marketId: market.id, shopId: shop.id, search: query || undefined, leadImageOnly: true });
  return <>
    <div className="shell mp-page mp-shop-page">
      <header className="mp-shop-hero">
        <Store size={35} aria-hidden="true"/>
        <h1 className="mp-page-title">{shop.name}</h1>
        <p>{shop._count.followers} {shop._count.followers === 1 ? "admirer" : "admirers"} · {market.name}</p>
        {shop.announcement && <p className="mp-section">{shop.announcement}</p>}
        <div className="mp-panel-links"><FollowShop shop={shop}/><MessageShop shop={shop.id} shopName={shop.name}/></div>
      </header>
      <nav className="mp-panel-links" aria-label="Shop sections"><a href="#shop-items">Items</a><a href="#shop-about">About</a></nav>
      <Form action={path} className="mp-inline" id="shop-items">
        <label className="store-dialog__field">Search this shop<input type="search" name="q" maxLength={120} defaultValue={query}/></label>
        <button className="button button--outline">Find items</button>
      </Form>
    </div>
    <ListingPage path={path} title={query ? `Items matching “${query}”` : "Shop items"} {...{ market, departments, products }}
      params={filters} query={query || undefined}/>
    <section className="shell mp-page mp-shop-about" id="shop-about"><h2>About {shop.name}</h2><p>{shop.about}</p></section>
  </>;
}
