import Link from "next/link";
import { notFound } from "next/navigation";
import { saveTaxonomyAction } from "@/app/staff/catalog-actions";
import { CatalogImageField } from "@/components/catalog-image-field";
import { StaffActionForm } from "@/components/staff-actions";
import { requireStaff } from "@/lib/staff/access";
import { catalogChoices } from "@/lib/staff/catalog";
import { departmentFamily } from "@/lib/catalog/departments";

type Entry = {
  id: string; name: string; slug: string; description: string; position: number;
  imageSrc: string | null; imageAlt: string | null; shortName?: string; selection?: string; parentId?: string | null;
};

type CategoryOption = { id: string; name: string; parentId?: string };

function TaxonomyForm({ kind, item, categories = [] }: { kind: "department" | "collection"; item?: Entry; categories?: readonly CategoryOption[] }) {
  const noun = kind === "department" ? "category" : "collection";
  const excluded = item && kind === "department" ? departmentFamily(categories, item.id) : new Set<string>();
  return (
    <details className="commerce-panel">
      <summary>{item ? `${item.name} · ${item.id}` : `Add ${noun}`}</summary>
      <StaffActionForm action={saveTaxonomyAction.bind(null, kind, item?.id ?? null)} submitLabel={`Save ${noun}`}>
        <div className="commerce-fields">
          <label>Name<input name="name" defaultValue={item?.name} required maxLength={100} /></label>
          <label>Stable ID<input name="id" defaultValue={item?.id} readOnly={Boolean(item)} required maxLength={80} /></label>
          <label>URL slug<input name="slug" defaultValue={item?.slug} required maxLength={70} /></label>
          <label>Position<input name="position" type="number" min={0} max={9999} defaultValue={item?.position ?? 100} required /></label>
        </div>
        <label>Description<textarea name="description" defaultValue={item?.description} rows={2} maxLength={1200} /></label>
        {kind === "department" ? (
          <>
            <label>Navigation label<input name="shortName" defaultValue={item?.shortName} maxLength={32} required /></label>
            <label>Parent category<select name="parentId" defaultValue={item?.parentId ?? ""}>
              <option value="">Top-level category</option>
              {categories.filter(category => !excluded.has(category.id)).map(category => <option key={category.id} value={category.id}>
                {category.parentId ? "↳ " : ""}{category.name}
              </option>)}
            </select></label>
          </>
        ) : (
          <label>Product selection<select name="selection" defaultValue={item?.selection ?? "CURATED"}>
            <option value="CURATED">Manually assigned</option>
            <option value="NEW">New arrivals</option>
            <option value="FEATURED">Featured products</option>
          </select></label>
        )}
        <CatalogImageField name="photo" src={item?.imageSrc ?? undefined} alt={item?.imageAlt ?? undefined} required={kind === "department"} />
      </StaffActionForm>
    </details>
  );
}

export default async function TaxonomyPage() {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const { departments, collections } = await catalogChoices(staff.id);
  const categories = departments.map(({ id, name, parentId }) => ({ id, name, parentId: parentId ?? undefined }));
  return (
    <>
      <div className="commerce-intro">
        <Link className="text-link" href="/staff/catalog">Product management</Link>
        <h1 className="display-type">Categories and collections</h1>
      </div>
      <div className="commerce-layout">
        <section className="commerce-stack" aria-labelledby="categories">
          <h2 id="categories">Categories</h2>
          <TaxonomyForm kind="department" categories={categories} />
          {departments.map((item) => <TaxonomyForm key={item.id} item={item} kind="department" categories={categories} />)}
        </section>
        <section className="commerce-stack" aria-labelledby="collections">
          <h2 id="collections">Collections</h2>
          <TaxonomyForm kind="collection" />
          {collections.map((item) => <TaxonomyForm key={item.id} item={item} kind="collection" />)}
        </section>
      </div>
    </>
  );
}
