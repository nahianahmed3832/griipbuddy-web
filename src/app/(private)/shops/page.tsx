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
  const values = await searchParams;
  const query = readQuery(values);
  const page = typeof values.page === "string" && /^\d{1,2}$/.test(values.page) ? Math.min(50, Math.max(1, Number(values.page))) : 1;
  const market = await currentMarket();
  const size = 20;
  const shops = await searchShops(query, market.id, (page - 1) * size, size + 1);
  const pageHref = (number: number) => "/shops?" + new URLSearchParams({ ...(query && { q: query }), page: String(number) });
  return <div className="shell mp-page">
    <section className="mp-shop-hero">
      <h1 className="mp-page-title">Find a shop</h1>
      <Form action="/shops" className="mp-inline">
        <label className="store-dialog__field">Search by shop name<input type="search" name="q" defaultValue={query} maxLength={120}/></label>
        <button className="button button--primary"><Search size={16}/> Search shops</button>
      </Form>
    </section>
    <h2>{query ? `Shops matching “${query}”` : "Browse shops"}</h2>
    {shops.length ? <ul className="mp-shop-grid">{shops.slice(0, size).map(shop => <li key={shop.id}>
      <Link href={`/shops/${shop.slug}`}><Building2 size={24} aria-hidden="true"/><strong>{shop.name}</strong>
        <p>{(shop.announcement || shop.about).slice(0, 160)}</p><span>Visit shop <span aria-hidden="true">→</span></span></Link>
    </li>)}</ul> : <p>{query ? "No shops match this search." : "No shops are listed on this page."}</p>}
    {(page > 1 || shops.length > size) && <nav className="mp-panel-links" aria-label="Shop directory pages">
      {page > 1 && <Link href={pageHref(page - 1)}>Previous page</Link>}
      <span>Page {page}</span>
      {page < 50 && shops.length > size && <Link href={pageHref(page + 1)}>Next page</Link>}
    </nav>}
  </div>;
}
