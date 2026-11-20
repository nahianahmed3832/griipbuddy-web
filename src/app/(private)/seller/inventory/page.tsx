import Link from "next/link";
import { Boxes, Download } from "lucide-react";
import { notFound } from "next/navigation";
import { SellerEmpty, SellerPageHeader, SellerPager, SellerStatus } from "@/components/marketplace/seller-ui";
import { SellerStockImportForm } from "@/components/marketplace/seller-stock-import-form";
import { SignInGate } from "@/components/marketplace/session";
import { markets } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { currentMarket } from "@/lib/market-server";
import { readSellerStock, sellerStockFilters } from "@/lib/marketplace/seller-stock";
import { sellerWorkspace } from "@/lib/marketplace/seller-workspace";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";
import { CatalogWriteError } from "@/lib/staff/operation-error";

export const metadata = { title: "Seller inventory" };
const pageSize = 20;
const statuses = [["available", "Available units"], ["low", "At or below threshold"], ["reserved", "Has reservations"], ["unrouted", "No active route"]];

export default async function SellerInventory({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!marketplaceMode() || firstPartyStoreMode()) notFound();
  const [{ shopper, shop }, market, query] = await Promise.all([sellerWorkspace(), currentMarket(), searchParams]);
  if (!shopper) return <SignInGate>Sign in to view inventory.</SignInGate>;
  const read = (key: string) => typeof query[key] === "string" ? query[key] : undefined;
  const filters = sellerStockFilters(read);
  const requestedPage = read("page");
  const page = requestedPage && /^[1-9]\d{0,3}$/.test(requestedPage) ? Number(requestedPage) : 1;
  const scope = new URLSearchParams({ market: market.id, ...(filters.q && { q: filters.q }),
    ...(filters.locationId && { location: filters.locationId }), ...(filters.status && { status: filters.status }) });
  const url = (target: number) => `/seller/inventory?${new URLSearchParams({ ...Object.fromEntries(scope), page: String(target) })}`;
  let result;
  try { result = await readSellerStock(shopper.id, market.id, filters); }
  catch (error) {
    if (!(error instanceof CatalogWriteError)) throw error;
    return <><SellerPageHeader title="Inventory" description={shop ? `${market.name} · ${shop.name}` : market.name}/>
      <SellerEmpty title="Stock view unavailable">{error.message} <Link href={`/seller/inventory?market=${market.id}`}>Clear filters</Link></SellerEmpty></>;
  }
  const rows = result.rows.slice((page - 1) * pageSize, page * pageSize);
  return <>
    <SellerPageHeader title="Inventory" description={`${market.name} · ${result.shop.name}`} actions={<>
      <Link className="seller-button" href={`/seller/listings?market=${market.id}`}><Boxes size={16} aria-hidden="true"/> Products</Link>
      <a className="seller-button" href={storefrontPath(`/api/marketplace/seller/inventory.csv?${scope}`)} download><Download size={16} aria-hidden="true"/> Export CSV</a>
    </>}/>
    <section className="seller-panel" aria-label="Inventory filters">
      <form action={storefrontPath("/seller/inventory")} method="get" className="seller-filters">
        <input type="hidden" name="market" value={market.id}/>
        <label>Product or SKU<input name="q" type="search" maxLength={100} defaultValue={filters.q}/></label>
        <label>Warehouse<select name="location" defaultValue={filters.locationId}><option value="">All permitted warehouses</option>
          {result.locations.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
        <label>Status<select name="status" defaultValue={filters.status ?? ""}><option value="">Any status</option>
          {statuses.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
        <button className="seller-button seller-button-primary" type="submit">Apply filters</button>
      </form>
    </section>
    {result.owner && <SellerStockImportForm key={market.id} marketId={market.id}/>}
    <section className="seller-panel" aria-labelledby="stock-pools">
      <div className="seller-panel-heading"><div><h2 id="stock-pools">Owned stock pools</h2>
        <p className="seller-muted">On hand includes reserved units. Available is on hand less reserved. Unavailable includes reserved units and units without a route in {market.name}.</p></div></div>
      {rows.length ? <div className="seller-table-wrap"><table className="seller-table" aria-labelledby="stock-pools">
        <thead><tr>{["Product", "Warehouse", "On hand", "Reserved", "Available", "Unavailable", "Status", "Action"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td data-label="Product"><span><strong>{row.productName}</strong><small>{row.sku} · {row.variantLabel}</small></span></td>
          <td data-label="Warehouse"><span>{row.locationName}<small>{row.markets.map(id => markets[id].name).join(" · ") || "No active routes"}</small></span></td>
          <td data-label="On hand">{row.onHand}</td><td data-label="Reserved">{row.reserved}</td>
          <td data-label="Available">{row.available}</td><td data-label="Unavailable">{row.unavailable}</td>
          <td data-label="Status"><span><SellerStatus tone={row.low ? "warning" : "muted"}>{!row.routeEnabled ? "Route unavailable" : row.low ? "Low stock" : "Routed"}</SellerStatus>
            {row.lowStockThreshold !== null && <small>Threshold {row.lowStockThreshold}</small>}</span></td>
          <td data-label="Action"><Link className="seller-table-action" href={`/seller/listings/${row.productId}?market=${market.id}#inventory`}>Manage stock</Link></td>
        </tr>)}</tbody>
      </table></div> : <SellerEmpty title="No stock pools match">Open a pool from an eligible product to record stock at an approved warehouse.</SellerEmpty>}
      <SellerPager page={page} hasNext={page * pageSize < result.rows.length} pageHref={url} label="Stock pages"/>
    </section>
  </>;
}
