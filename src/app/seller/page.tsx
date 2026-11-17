import Link from "next/link";
import { notFound } from "next/navigation";
import { hybridStoreMode, marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { getDb } from "@/lib/db/client";
import { threadsFor } from "@/lib/marketplace/data";
import { SignInGate } from "@/components/marketplace/session";
import { SellerMarkets, ShopForm } from "@/components/marketplace/seller";
import { ThreadLinks } from "@/components/marketplace/messages";
import { markets, formatMoney } from "@/config/markets";

export const metadata = { title: "Shop Manager" };

export default async function SellerPage() {
  if (!marketplaceMode()) notFound();
  const heading = <h1 className="mp-page-title">Shop Manager</h1>;
  const shopper = await getShopper();
  if (!shopper) return <div className="shell mp-page">{heading}<SignInGate>Sign in to open or manage your shop.</SignInGate></div>;
  const db = getDb();
  const hybrid = hybridStoreMode();
  const shop = await db.marketplaceShop.findUnique({ where: { ownerId: shopper.id }, include: { marketGrants: true } });
  if (!shop) return <div className="shell mp-page">{heading}<p>Tell us about your shop to get started.</p><ShopForm/></div>;
  const [listings, inbox, sold] = await Promise.all([
    db.product.findMany({ where: { marketplaceShopId: shop.id }, orderBy: { addedOn: "desc" }, take: 60, select: {
      id: true, name: true, slug: true, publication: true,
      variants: { select: { inventory: { select: { available: true } } } },
    } }), threadsFor(shopper.id, shop.id),
    db.orderItem.findMany({ where: { marketplaceShopId: shop.id }, orderBy: { order: { createdAt: "desc" } }, take: 60,
      select: { id: true, productName: true, quantity: true, lineTotalMinor: true, order: {
        select: { reference: true, status: true, fulfillmentStatus: true, createdAt: true, marketId: true },
      } } }),
  ]);
  const mayList = !hybrid || shop.marketGrants.some(grant => grant.status === "APPROVED");
  return <div className="shell mp-page">
    <section className="mp-shop-hero">{heading}<h2>{shop.name}</h2>
      <p>{shop.published ? "Public shop" : "Private · Waiting for owner review"}</p>
      <div className="mp-panel-links">
        {mayList && <Link className="button button--primary" href="/seller/listings/new">Add a listing</Link>}
        {shop.published && (hybrid ? shop.marketGrants.filter(grant => grant.status === "APPROVED").map(({ marketId }) =>
          <Link key={marketId} className="button button--outline"
            href={marketId === "bd" ? `/bd/shops/${shop.slug}` : `/shops/${shop.slug}?market=us`}>
            View {markets[marketId].name} shop
          </Link>) : <Link className="button button--outline" href={`/shops/${shop.slug}`}>View your shop</Link>)}
      </div>
    </section>
    <nav className="mp-panel-links" aria-label="Seller sections">{hybrid && <a href="#markets">Markets</a>}<a href="#listings">Listings</a><a href="#orders">Orders</a>
      <a href="#inbox">Messages</a><a href="#settings">Shop settings</a></nav>
    {hybrid && <section className="mp-section" id="markets"><h2>Selling markets</h2><SellerMarkets grants={shop.marketGrants}/></section>}
    <section className="mp-section" id="listings"><h2>Listings</h2>
      {listings.length === 0 ? <p>No listings yet.</p> : <ul className="mp-shop-grid">{listings.map(listing => <li className="mp-list-card" key={listing.id}>
        <strong>{listing.name}</strong><p>{listing.publication === "DRAFT" ? "Draft" : listing.publication === "ACTIVE" ? "Published" : "Archived"} · {listing.variants.reduce((sum, variant) => sum + (variant.inventory?.available ?? 0), 0)} in stock</p>
        <Link href={`/seller/listings/${listing.id}`}>{listing.publication === "DRAFT" ? "Edit draft" : "See listing details"}</Link>
      </li>)}</ul>}
    </section>
    <section className="mp-section" id="orders"><h2>Shop orders</h2>
      <div className="mp-panel-links"><Link prefetch={false} href="/seller/orders">Manage orders and download reports</Link></div>
      {sold.length === 0 ? <p>No orders for this shop yet.</p> : <ul className="mp-shop-grid">{sold.map(line => <li key={line.id} className="mp-list-card">
        <strong>{line.order.reference}</strong><p>{line.quantity} × {line.productName}</p>
        <p>{formatMoney(line.lineTotalMinor, markets[line.order.marketId])} · {line.order.status === "CANCELLED" ? "Cancelled" : line.order.fulfillmentStatus.toLowerCase().replaceAll("_", " ")}</p>
      </li>)}</ul>}
    </section>
    <section className="mp-section" id="inbox"><h2>Shop inbox</h2><ThreadLinks rows={inbox}/></section>
    <section className="mp-section" id="settings"><h2>Shop settings</h2><ShopForm shop={shop}/></section>
  </div>;
}
