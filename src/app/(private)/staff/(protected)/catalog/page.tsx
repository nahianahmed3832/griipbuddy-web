import Link from "next/link";
import { marketList } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { requireStaff } from "@/lib/staff/access";
import { merchandisingEnabled } from "@/lib/staff/merchandising-config";
import { listProductWorkspace } from "@/lib/staff/product-workspace";
import "./taxonomy/taxonomy.css";
import "./product-workspace.css";

export const metadata = { title: "Product management" };
const labels = { ACTIVE: "Published", DRAFT: "Draft", ARCHIVED: "Archived" } as const;
const root = "/staff/catalog";

export default async function ProductManagement({ searchParams }: {
  searchParams: Promise<{ q?: string; page?: string; state?: string; source?: string; market?: string }>;
}) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 80) : "";
  const page = typeof params.page === "string" && /^\d{1,4}$/.test(params.page) ? Math.max(1, Number(params.page)) : 1;
  const state = params.state === "DRAFT" || params.state === "ARCHIVED" || params.state === "ACTIVE" ? params.state : undefined;
  const source = params.source === "connected" || params.source === "legacy" ? params.source : undefined;
  const market = marketList.find(row => row.id === params.market)?.id;
  const view = await listProductWorkspace(staff.id, { q: query, state, source, market, page });
  const pageHref = (number: number) => `${root}?${new URLSearchParams({ q: query, page: String(number),
    ...(state && { state }), ...(source && { source }), ...(market && { market }) })}`;
  return <div className="taxonomy-workspace connected-product-workspace">
    <header className="taxonomy-heading">
      <div><h1 className="display-type">Product management</h1>
        <p>Manage the shared catalog, physical variants and local offers.</p></div>
      {view?.owner && <Link className="button button--primary" href="/staff/catalog/products/new">Create product</Link>}
    </header>
    {!view ? <section className="taxonomy-card" role="status"><h2>Catalog access is unavailable</h2>
      <p>Commercial access is required to manage products and offers.</p></section> : <>
      {view.owner && <nav className="catalog-links" aria-label="Catalog tools">
        {merchandisingEnabled() && <Link className="button button--outline" href="/staff/catalog/merchandising">Merchandising</Link>}
        <Link className="button button--outline" href="/staff/catalog/import">Import CSV</Link>
        <Link className="button button--outline" href="/staff/catalog/feeds">Google Shopping feeds</Link>
        <Link className="button button--outline" href="/staff/catalog/taxonomy">Catalog organization</Link>
      </nav>}
      <section className="taxonomy-card">
        <form className="commerce-form taxonomy-fields product-workspace-filters" action={storefrontPath(root)}>
          <label>Search products<input name="q" defaultValue={query} maxLength={80} type="search" placeholder="Name, brand, ID or SKU" /></label>
          <label>Publication<select name="state" defaultValue={state ?? ""}><option value="">All states</option>
            {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {view.owner && <label>Catalog source<select name="source" defaultValue={source ?? ""}>
            <option value="">All products</option><option value="connected">Connected</option><option value="legacy">Legacy</option>
          </select></label>}
          <label>Offer market<select name="market" defaultValue={market ?? ""}><option value="">All accessible markets</option>
            {marketList.filter(row => view.marketIds.includes(row.id)).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select></label>
          <button className="button button--outline" type="submit">Find products</button>
        </form>
      </section>
      <section className="taxonomy-card" aria-labelledby="products-heading">
        <h2 id="products-heading">Catalog products</h2>
        {!view.rows.length ? <p>No products match this search.</p> : <div className="taxonomy-scroll">
          <table className="taxonomy-table product-workspace-table">
            <thead><tr><th scope="col">Product</th><th scope="col">Primary category</th><th scope="col">Variants</th>
              <th scope="col">Market offers</th><th scope="col">Status</th></tr></thead>
            <tbody>{view.rows.map(row => <tr key={row.id}>
              <th scope="row"><Link href={`/staff/catalog/products/${encodeURIComponent(row.id)}`}>{row.name}</Link>
                <div className="taxonomy-muted">{row.id}</div></th>
              <td>{row.category}</td><td>{row.variants}</td>
              <td>{row.markets.map(id => marketList.find(market => market.id === id)?.currency).join(", ") || "None published"}</td>
              <td><div className="product-workspace-statuses"><span className="taxonomy-badge" data-state={row.publication.toLowerCase()}>
                {row.publication === "ACTIVE" && !row.active ? "Inactive" : labels[row.publication]}</span>
                {row.incomplete && <span className="taxonomy-badge" data-state="draft">Incomplete</span>}
                {!row.foundation && <span className="taxonomy-badge">Legacy</span>}
                {row.demo && <span className="taxonomy-badge">Sample</span>}</div></td>
            </tr>)}</tbody>
          </table>
        </div>}
        <nav className="taxonomy-actions product-workspace-pagination" aria-label="Product pages">
          {page > 1 && <Link className="text-link" href={pageHref(page - 1)}>Previous page</Link>}
          <span className="taxonomy-muted">Page {page}</span>
          {view.hasNext && <Link className="text-link" href={pageHref(page + 1)}>Next page</Link>}
        </nav>
      </section>
    </>}
  </div>;
}
