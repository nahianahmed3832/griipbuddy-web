import Link from "next/link";
import { storefrontPath } from "@/config/storefront-path";
import { notFound } from "next/navigation";
import { ownerProducts } from "@/lib/staff/catalog";
import { requireStaff } from "@/lib/staff/access";
import { merchandisingEnabled } from "@/lib/staff/merchandising-config";

export const metadata = { title: "Product management" };
const labels = { ACTIVE: "Active", DRAFT: "Draft", ARCHIVED: "Archived" };

export default async function ProductManagement({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 80) : "";
  const page = /^\d{1,4}$/.test(params.page ?? "") ? Math.max(1, Number(params.page)) : 1;
  const { rows, hasNext } = await ownerProducts(staff.id, query, page);
  const pageHref = (number: number) => `/staff/catalog?q=${encodeURIComponent(query)}&page=${number}`;
  return (
    <>
      <div className="commerce-intro">
        <h1 className="display-type">Product management</h1>
      </div>
      <div className="catalog-links">
        {merchandisingEnabled() && <Link className="button button--outline" href="/staff/catalog/merchandising">Merchandising</Link>}
        <Link className="button button--primary" href="/staff/catalog/products/new">Create product</Link>
        <Link className="button button--outline" href="/staff/catalog/import">Import CSV</Link>
        <Link className="button button--outline" href="/staff/catalog/feeds">Google Shopping feeds</Link>
        <Link className="button button--outline" href="/staff/catalog/taxonomy">Categories and collections</Link>
      </div>
      <form className="catalog-search commerce-form" action={storefrontPath("/staff/catalog")}>
        <label>Search by product name, ID, or SKU<input name="q" defaultValue={query} maxLength={80} type="search" /></label>
        <button className="button button--outline" type="submit">Find products</button>
      </form>
      {rows.length === 0 && <p>No products match this search.</p>}
      <ul className="staff-orders" aria-label="Catalog products">
        {rows.map((product) => <li className="commerce-panel staff-order-row" key={product.id}>
          <div>
            <Link className="staff-order-ref" href={`/staff/catalog/products/${product.id}`}>{product.name}</Link>
            <p>{product.id} · {product.department.name} · {product._count.variants} {product._count.variants === 1 ? "variant" : "variants"}</p>
          </div>
          <span className="staff-status">{labels[product.publication]}{product.demo && " · Staging sample"}</span>
          <Link className="text-link" href={`/staff/catalog/inventory?q=${product.id}`} aria-label={`Inventory for ${product.name}`}>Inventory</Link>
        </li>)}
      </ul>
      <div className="catalog-links">
        {page > 1 && <Link className="text-link" href={pageHref(page - 1)}>Previous page</Link>}
        {hasNext && <Link className="text-link" href={pageHref(page + 1)}>Next page</Link>}
      </div>
    </>
  );
}
