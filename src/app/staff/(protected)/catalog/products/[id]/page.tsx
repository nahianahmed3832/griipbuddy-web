import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductEditor } from "@/components/product-editor";
import { requireStaff } from "@/lib/staff/access";
import { catalogChoices, ownerProduct } from "@/lib/staff/catalog";
import { productIdField } from "@/lib/staff/catalog-input";
import { productionMode } from "@/lib/release-config";

export const metadata = { title: "Product editor" };

export default async function ProductEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const { id } = await params;
  if (!productIdField.safeParse(id).success) notFound();
  const existing = await ownerProduct(staff.id, id);
  if (!existing) notFound();
  const choices = await catalogChoices(staff.id);
  return (
    <>
      <div className="commerce-intro">
        <Link className="text-link" href="/staff/catalog">Product management</Link>
        <h1 className="display-type">Edit {existing.product.name}</h1>
      </div>
      <ProductEditor existing={existing} departments={choices.departments} collections={choices.collections} production={productionMode()} />
    </>
  );
}
