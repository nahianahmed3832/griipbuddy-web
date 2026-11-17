import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductEditor } from "@/components/product-editor";
import { requireStaff } from "@/lib/staff/access";
import { catalogChoices } from "@/lib/staff/catalog";
import { productionMode } from "@/lib/release-config";

export const metadata = { title: "Create product" };

export default async function NewProductPage() {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const choices = await catalogChoices(staff.id);
  return (
    <>
      <div className="commerce-intro">
        <Link className="text-link" href="/staff/catalog">Product management</Link>
        <h1 className="display-type">Create product</h1>
      </div>
      <ProductEditor existing={null} departments={choices.departments} collections={choices.collections} production={productionMode()} />
    </>
  );
}
