import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, Search } from "lucide-react";
import { readQuery, type SearchParams } from "@/lib/catalog/listing";
import { marketplaceMode } from "@/lib/release-config";
import { searchShops } from "@/lib/marketplace/data";
import { currentMarket } from "@/lib/market-server";

export const metadata = { title: "Find shops" };

export default async function ShopsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!marketplaceMode()) notFound();
  const query = readQuery(await searchParams);
  const market = await currentMarket();
  const shops = await searchShops(query, market.id);
  return <div className="shell mp-page">
    <section className="mp-shop-hero">
      <h1 className="mp-page-title">Find a shop</h1>
      <Form action="/shops" className="mp-inline">
        <label className="store-dialog__field">Search by shop name<input type="search" name="q" defaultValue={query} maxLength={120}/></label>
        <button className="button button--primary"><Search size={16}/> Search shops</button>
      </Form>
    </section>
    <h2>{query ? `Shops matching “${query}”` : "Browse shops"}</h2>
    {shops.length ? <ul className="mp-shop-grid">{shops.map(shop => <li key={shop.id}>
      <Link href={`/shops/${shop.slug}`}><Building2 size={24} aria-hidden="true"/><strong>{shop.name}</strong>
        <p>{shop.announcement || shop.about.slice(0, 160)}</p><span>Visit shop →</span></Link>
    </li>)}</ul> : <p>No shops match this name. Try a shorter search.</p>}
  </div>;
}
