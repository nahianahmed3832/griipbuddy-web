import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { updatePriceAction, updateStockAction } from "@/app/staff/actions";
import { StaffActionForm } from "@/components/staff-actions";
import { markets } from "@/config/markets";
import { requireStaff } from "@/lib/staff/access";
import { listStaffCatalog } from "@/lib/staff/operations";
import { usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";

export const metadata: Metadata = { title: "Staff inventory and prices" };

export default async function StaffInventoryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  if (usesBangladeshCheckout()) return <section className="commerce-panel">
    <h1 className="display-type">Inventory and prices</h1>
    <p>Bangladesh prices and available stock are refreshed from the existing GriipBuddy store.</p>
    <a className="text-link" href="https://admin.griipbuddy.com/">Manage inventory and prices in GriipBuddy admin</a>
  </section>;
  const { q } = await searchParams;
  const variants = await listStaffCatalog(staff.id, typeof q === "string" ? q : undefined);

  return (
    <>
      <div className="commerce-intro">
        <h1 className="display-type">Inventory and prices</h1>
        <p>Adjust the available stock shared by both markets and edit prices for existing offers.</p>
        <Link className="text-link" href="/staff/catalog">Find a product by name or SKU</Link>
      </div>
      <div className="staff-catalog">
        {variants.map((variant) => (
          <section className="commerce-panel" key={variant.id}>
            <h2>{variant.product.name}</h2>
            <p>{variant.label} · {variant.sku}</p>
            {variant.inventory && (
              <StaffActionForm action={updateStockAction.bind(null, variant.id)} submitLabel="Adjust stock" secondary>
                <label>Stock adjustment ({variant.inventory.available} available)
                  <input name="delta" type="number" step="1" min="-10000" max="10000" placeholder="+5 or -2" required />
                </label>
                <label>Adjustment reason<input name="reason" minLength={3} maxLength={200} required /></label>
              </StaffActionForm>
            )}
            {variant.offers.map(({ marketId, amountMinor }) => (
              <StaffActionForm
                key={marketId}
                action={updatePriceAction.bind(null, variant.id, marketId, amountMinor)}
                submitLabel={`Save ${markets[marketId].currency} price`}
                secondary
              >
                <label>{markets[marketId].name} price ({markets[marketId].currency})
                  <input key={amountMinor} name="price" type="number" step=".01" min=".01" max="150000" defaultValue={(amountMinor / 100).toFixed(2)} required />
                </label>
              </StaffActionForm>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
