import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectedProductAuthoring } from "@/components/connected-product-authoring";
import { ProductEditor } from "@/components/product-editor";
import { TaxonomyPendingChanges } from "@/components/taxonomy-controls";
import { productionMode } from "@/lib/release-config";
import { requireLegacyCatalogPage } from "@/lib/catalog/main-admin-legacy-page";
import { catalogChoices } from "@/lib/staff/catalog";
import { productCategoryChoices } from "@/lib/staff/product-workspace";
import "../../taxonomy/taxonomy.css";
import "../../product-workspace.css";

export const metadata = { title: "Create product" };

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ editor?: string }> }) {
  const [staff, params] = await Promise.all([requireLegacyCatalogPage(), searchParams]);
  if (staff.role !== "OWNER") notFound();
  if (params.editor === "legacy") {
    const choices = await catalogChoices(staff.id);
    return <>
      <div className="commerce-intro"><Link className="text-link" href="/staff/catalog/products/new">Connected editor</Link>
        <h1 className="display-type">Create legacy product</h1></div>
      <ProductEditor existing={null} departments={choices.departments} collections={choices.collections} production={productionMode()} />
    </>;
  }
  const categories = await productCategoryChoices(staff.id);
  return <TaxonomyPendingChanges>
    <div className="taxonomy-workspace connected-product-workspace">
      <header className="taxonomy-heading"><div>
        <Link className="text-link" href="/staff/catalog">Product management</Link>
        <h1 className="display-type">Create product</h1>
        <p>Save a shared draft, then configure media, market offers and stock.</p>
      </div><Link className="button button--outline" href="/staff/catalog/products/new?editor=legacy">Legacy editor</Link></header>
      {categories.length ? <ConnectedProductAuthoring product={null} categories={categories} /> :
        <section className="taxonomy-card" role="status"><h2>Choose a primary category first</h2>
          <p>Create an active subcategory before saving a connected product.</p>
          <Link className="text-link" href="/staff/catalog/taxonomy">Open category management</Link>
        </section>}
    </div>
  </TaxonomyPendingChanges>;
}
