import Link from "next/link";
import { storefrontPath } from "@/config/storefront-path";
import { productionMode } from "@/lib/release-config";
import { notFound } from "next/navigation";
import { CatalogImport } from "@/components/catalog-import";
import { requireStaff } from "@/lib/staff/access";
import { catalogChoices } from "@/lib/staff/catalog";

export const metadata = { title: "Import products" };

export default async function ImportProductsPage() {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const { departments, collections } = await catalogChoices(staff.id);
  return (
    <>
      <div className="commerce-intro">
        <Link className="text-link" href="/staff/catalog">Product management</Link>
        <h1 className="display-type">Import products</h1>
        <p>Use one row per variant, with the same product fields on every row for that product. Preview the file before applying it.</p>
      </div>
      <div className="catalog-links">
        <a className="button button--outline" href={storefrontPath("/templates/catalog-template.csv")} download>Download CSV template</a>
        {!productionMode() && <a className="button button--outline" href={storefrontPath("/templates/catalog-example.csv")} download>Download staging example</a>}
      </div>
      <CatalogImport />
      <details className="commerce-panel catalog-editor">
        <summary>Fields and accepted IDs</summary>
        <p>Use whole minor units for prices. For example, 125000 BDT means ৳1,250. Enter true or false for flags. Leave all three market fields empty to disable that offer for the listed SKU.</p>
        <p>Images use paths from the product editor upload or a bundled image. Enter attributes and the gallery as JSON arrays, options as a JSON object, and use | between collection IDs or keywords.</p>
        <p>New SKUs start at zero available stock. An import preserves inventory and SKUs outside the file.</p>
        <p>Categories · {departments.map(({ name, id }) => `${name} (${id})`).join(", ")}</p>
        <p>Collections · {collections.map(({ name, id }) => `${name} (${id})`).join(", ")}</p>
      </details>
    </>
  );
}
