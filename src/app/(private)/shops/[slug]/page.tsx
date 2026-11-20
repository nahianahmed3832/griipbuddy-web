import { notFound } from "next/navigation";
import Form from "next/form";
import { Store } from "lucide-react";
import { marketplaceMode } from "@/lib/release-config";
import { getDb } from "@/lib/db/client";
import { shopProducts } from "@/lib/catalog/shop-products";
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
      id: true, slug: true, name: true, announcement: true, about: true,
      marketGrants: { where: { marketId: market.id, status: "APPROVED" }, select: {
        profile: { select: { announcement: true, about: true, presentation: true } },
      } },
    } }), catalog.listDepartments(market.id), searchParams,
  ]);
  if (!shop) notFound();
  const profile = shop.marketGrants[0]?.profile;
  const announcement = profile?.announcement ?? shop.announcement;
  const query = readQuery(filters);
  const path = `/shops/${shop.slug}`;
  const products = await shopProducts(shop, market, query, departments);
  return <>
    <div className="shell mp-page mp-shop-page">
      <header className="mp-shop-hero" data-presentation={profile?.presentation}>
        <Store size={35} aria-hidden="true"/>
        <h1 className="mp-page-title">{shop.name}</h1>
        <p>{market.name}</p>
        {announcement && <p className="mp-section">{announcement}</p>}
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
    <section className="shell mp-page mp-shop-about" id="shop-about"><h2>About {shop.name}</h2><p>{profile?.about ?? shop.about}</p></section>
  </>;
}
