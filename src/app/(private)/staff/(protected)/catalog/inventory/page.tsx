import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { createDispatchLocationAction, moveSharedStockAction, updateLocationStockAction, updatePriceAction, updateStockAction } from "@/app/staff/actions";
import { StaffActionForm } from "@/components/staff-actions";
import { markets } from "@/config/markets";
import { requireLegacyCatalogPage } from "@/lib/catalog/main-admin-legacy-page";
import { listStaffCatalog } from "@/lib/staff/operations";
import { usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";
import { inventoryShopId } from "@/lib/commerce/location-inventory";
import { staffDispatchLocations } from "@/lib/staff/location-inventory";

export const metadata: Metadata = { title: "Staff inventory and prices" };

type Location = Awaited<ReturnType<typeof staffDispatchLocations>>["locations"][number];
type Variant = Awaited<ReturnType<typeof listStaffCatalog>>[number];

function StockLocations({ variant, locations }: { variant: Variant; locations: Location[] }) {
  if (!locations.length && !variant.locationInventory.length) return null;
  const stock = new Map(variant.locationInventory.map(row => [row.locationId, row.available]));
  const assigned = stock.size > 0;
  const shared = variant.inventory?.available ?? 0;
  const active = locations.filter(location => location.active);
  const options = (availableLocations: Location[]) => availableLocations.map(location => (
    <option value={location.id} key={location.id}>
      {location.name} ({location.marketId ? markets[location.marketId].name : "Shared"}) · {stock.get(location.id) ?? 0} units
    </option>
  ));

  return <div>
    <h3>Stock by dispatch location</h3>
    <ul className="staff-history">
      {locations.filter(location => stock.has(location.id)).map(location => <li key={location.id}>
        <strong>{location.name}</strong><span>{stock.get(location.id)} available{!location.active ? " · Inactive" : ""}</span>
      </li>)}
      {assigned && shared > 0 && <li><strong>Shared stock</strong><span>{shared} units available to move</span></li>}
    </ul>
    {!assigned && <p className="commerce-muted">This variant uses an available stock pool shared across markets.</p>}
    {active.length > 0 && (!assigned || shared > 0) && (
      <StaffActionForm action={moveSharedStockAction.bind(null, variant.id, shared)} submitLabel={shared ? "Move shared stock" : "Assign location"} secondary>
        {!assigned && <p className="commerce-muted">The first assignment moves all {shared} shared units. Each market then draws from its own eligible locations.</p>}
        <label>Move stock to<select name="locationId" defaultValue="" required>
          <option value="" disabled>Choose a dispatch location</option>{options(active)}
        </select></label>
        <label>Move reason<input name="reason" minLength={3} maxLength={200} required /></label>
      </StaffActionForm>
    )}
    {locations.length > 0 && (assigned || shared === 0) && (
      <StaffActionForm action={updateLocationStockAction.bind(null, variant.id)} submitLabel="Adjust location stock" secondary>
        <label>Dispatch location<select name="locationId" defaultValue="" required>
          <option value="" disabled>Choose a dispatch location</option>{options(locations)}
        </select></label>
        <label>Location stock adjustment<input name="delta" type="number" step="1" min="-10000" max="10000" placeholder="+5 or -2" required /></label>
        <label>Location adjustment reason<input name="reason" minLength={3} maxLength={200} required /></label>
      </StaffActionForm>
    )}
  </div>;
}

export default async function StaffInventoryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const staff = await requireLegacyCatalogPage();
  if (staff.role !== "OWNER") notFound();
  if (usesBangladeshCheckout()) return <section className="commerce-panel">
    <h1 className="display-type">Inventory and prices</h1>
    <p>Bangladesh prices and available stock are refreshed from the existing GriipBuddy store.</p>
    <a className="text-link" href="https://admin.griipbuddy.com/">Manage inventory and prices in GriipBuddy admin</a>
  </section>;
  const { q } = await searchParams;
  const [variants, { locations, sellers }] = await Promise.all([
    listStaffCatalog(staff.id, typeof q === "string" ? q : undefined), staffDispatchLocations(staff.id),
  ]);
  const sellerNames = new Map(sellers.map(seller => [seller.id, seller.name]));

  return (
    <>
      <div className="commerce-intro">
        <h1 className="display-type">Inventory and prices</h1>
        <p>Manage available stock by dispatch location and edit prices for existing market offers.</p>
        <Link className="text-link" href="/staff/catalog">Find a product by name or SKU</Link>
      </div>
      <section className="commerce-panel">
        <h2>Dispatch locations</h2>
        {locations.length > 0 && <ul className="staff-history">
          {locations.map(location => <li key={location.id}>
            <strong>{location.name}</strong>
            <span>{location.marketId ? markets[location.marketId].name : "Shared"} · {location.shopId ? sellerNames.get(location.shopId) ?? "Seller" : "GriipBuddy"} · Priority {location.priority}{!location.active ? " · Inactive" : ""}</span>
          </li>)}
        </ul>}
        <StaffActionForm action={createDispatchLocationAction} submitLabel="Create dispatch location" secondary>
          <label>Location name<input name="name" minLength={3} maxLength={80} required /></label>
          <label>Market served<select name="marketId" defaultValue="" required>
            <option value="" disabled>Choose a market</option>
            {Object.entries(markets).map(([marketId, market]) => <option key={marketId} value={marketId}>{market.name}</option>)}
          </select></label>
          <label>Stock owner<select name="shopId" defaultValue="">
            <option value="">GriipBuddy</option>
            {sellers.filter(seller => seller.published).map(seller => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
          </select></label>
          <label>Dispatch priority (lowest first)<input name="priority" type="number" min="0" max="1000" step="1" defaultValue={100} required /></label>
        </StaffActionForm>
      </section>
      <div className="staff-catalog">
        {variants.map((variant) => (
          <section className="commerce-panel" key={variant.id}>
            <h2>{variant.product.name}</h2>
            <p>{variant.label} · {variant.sku}</p>
            {variant.inventory && variant.locationInventory.length === 0 && (
              <StaffActionForm action={updateStockAction.bind(null, variant.id)} submitLabel="Adjust stock" secondary>
                <label>Stock adjustment ({variant.inventory.available} available)
                  <input name="delta" type="number" step="1" min="-10000" max="10000" placeholder="+5 or -2" required />
                </label>
                <label>Adjustment reason<input name="reason" minLength={3} maxLength={200} required /></label>
              </StaffActionForm>
            )}
            <StockLocations variant={variant} locations={locations.filter(location =>
              inventoryShopId(location.shopId) === inventoryShopId(variant.product.marketplaceShopId),
            )} />
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
