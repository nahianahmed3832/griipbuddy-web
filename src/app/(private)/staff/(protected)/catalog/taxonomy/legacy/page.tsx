import Link from "next/link";
import { notFound } from "next/navigation";
import { saveTaxonomyAction } from "@/app/staff/catalog-actions";
import { CatalogImageField } from "@/components/catalog-image-field";
import { StaffActionForm } from "@/components/staff-actions";
import { departmentFamily } from "@/lib/catalog/departments";
import { getDb } from "@/lib/db/client";
import { requireLegacyCatalogPage } from "@/lib/catalog/main-admin-legacy-page";
import { legacyCategoryScope } from "@/lib/catalog/scoped-pilot";

export default async function LegacyTaxonomyPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const [staff, { category }] = await Promise.all([requireLegacyCatalogPage(), searchParams]);
  if (staff.role !== "OWNER" || typeof category !== "string" || category.length > 80) notFound();
  const db = getDb();
  const rows = await db.department.findMany({ where: staff.scopedLegacyPilot ? await legacyCategoryScope(db) : { kind: null },
    orderBy: [{ position: "asc" }, { id: "asc" }] });
  const item = rows.find(row => row.id === category);
  if (!item) notFound();
  const excluded = departmentFamily(rows, item.id);

  return <>
    <header className="commerce-intro">
      <Link className="text-link" href={`/staff/catalog/taxonomy?category=${encodeURIComponent(item.id)}`}>Catalog organization</Link>
      <h1 className="display-type">{item.name}</h1>
      <p>Legacy category</p>
    </header>
    <section className="commerce-panel">
      <StaffActionForm action={saveTaxonomyAction.bind(null, "department", item.id)} submitLabel="Save legacy category">
        <div className="commerce-fields">
          <label>Name<input name="name" defaultValue={item.name} required maxLength={100} /></label>
          <label>Stable ID<input name="id" defaultValue={item.id} readOnly required /></label>
          <label>URL slug<input name="slug" defaultValue={item.slug} required maxLength={120} /></label>
          <label>Position<input name="position" type="number" min={0} max={9999} defaultValue={item.position} required /></label>
        </div>
        <label>Description<textarea name="description" defaultValue={item.description} rows={3} maxLength={1200} /></label>
        <label>Navigation label<input name="shortName" defaultValue={item.shortName} maxLength={32} required /></label>
        <label>Parent category<select name="parentId" defaultValue={item.parentId ?? ""}>
          <option value="">Top-level category</option>
          {rows.filter(row => !excluded.has(row.id)).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select></label>
        <CatalogImageField name="photo" src={item.imageSrc} alt={item.imageAlt} required />
      </StaffActionForm>
    </section>
  </>;
}
