import { notFound } from "next/navigation";
import { requireStaff } from "../staff/access";
import { mainAdminCatalogRequested } from "./main-admin-config";

export async function requireLegacyCatalogPage() {
  const staff = await requireStaff();
  if (mainAdminCatalogRequested()) notFound();
  return staff;
}
