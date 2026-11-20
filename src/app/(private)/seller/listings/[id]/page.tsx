import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { getDb } from "@/lib/db/client";
import { storefrontPath } from "@/config/storefront-path";
import { markets } from "@/config/markets";
import { ListingForm, ListingPhotoForm, SellerLocationStockForm } from "@/components/marketplace/seller";
import { dispatchStockRelations } from "@/lib/commerce/location-inventory";
import { isMarketSelectable } from "@/lib/market-config";
import { ConnectedProductCommerce } from "@/components/connected-product-commerce";
import { TaxonomyPendingChanges } from "@/components/taxonomy-controls";
import { sellerConnectedProductScope } from "@/lib/staff/product-workspace-commerce";
import "../../../staff/(protected)/catalog/taxonomy/taxonomy.css";
import "../../../staff/(protected)/catalog/product-workspace.css";

export const metadata = { title: "Manage listing" };

export default async function SellerListing({ params }: { params: Promise<{ id: string }> }) {
  if (!marketplaceMode()) notFound();
  const shopper = await getShopper();
  const db = getDb();
  const shop = shopper && await db.marketplaceShop.findUnique({ where: { ownerId: shopper.id }, select: {
    id: true, published: true, marketGrants: { where: { status: "APPROVED" }, select: { marketId: true } },
  } });
  if (!shop) redirect("/seller");
  const { id } = await params;
  const marketIds = shop.marketGrants.map(grant => grant.marketId).filter(isMarketSelectable);
  const [departments, item, connected] = await Promise.all([
    db.department.findMany({ select: { id: true, name: true }, orderBy: { position: "asc" } }),
    id === "new" ? null : db.product.findFirst({ where: { id, marketplaceShopId: shop.id, foundation: false }, include: {
      images: { orderBy: { position: "asc" } }, variants: { orderBy: { position: "asc" },
        include: { ...dispatchStockRelations, offers: { where: { eligible: true, marketId: { in: marketIds } } } } },
    } }),
    id === "new" ? null : db.product.findFirst({ where: { id, ...sellerConnectedProductScope(shop.id, shop.published ? marketIds : []) },
      select: { id: true, name: true, publication: true } }),
  ]);
  if (connected) return <TaxonomyPendingChanges>
    <div className="shell mp-page taxonomy-workspace connected-product-workspace">
      <Link href="/seller" className="text-link">Back to Shop Manager</Link>
      <h1 className="mp-page-title">{connected.name}</h1>
      <p>{connected.publication === "ACTIVE" ? "Published" : connected.publication === "DRAFT" ? "Catalog draft" : "Archived"}</p>
      <nav className="taxonomy-tabs" aria-label="Product commerce sections">
        <a href="#markets">Markets and offers</a><a href="#inventory">Inventory</a>
      </nav>
      <ConnectedProductCommerce productId={connected.id} actorKind="seller" />
    </div>
  </TaxonomyPendingChanges>;
  if (id !== "new" && !item) notFound();
  const variant = item?.variants[0];
  const listing = item && variant ? { id, name: item.name, description: item.description, departmentId: item.departmentId,
    tags: item.keywords.join(", "), sku: variant.sku.replace(/^M[0-9A-F]{10}-/, ""), amount: ((variant.offers[0]?.amountMinor ?? 0) / 100).toFixed(2),
    marketPrices: Object.fromEntries(variant.offers.map(offer => [offer.marketId, (offer.amountMinor / 100).toFixed(2)])),
    quantity: variant.inventory?.available ?? 0, locationManaged: variant.locationInventory.length > 0,
    personalization: item.personalizationPrompt ? { prompt: item.personalizationPrompt, required: item.personalizationRequired } : undefined,
  } : undefined;
  const stockRows = item?.variants.flatMap(({ id, label, sku, active, locationInventory }) => locationInventory
    .filter(stock => stock.location.shopId === shop.id)
    .map(stock => ({ ...stock, variantId: id, label, sku, active }))) ?? [];
  return <div className="shell mp-page">
    <Link href="/seller" className="text-link">Back to Shop Manager</Link>
    <h1 className="mp-page-title">{item?.name ?? "Add a listing"}</h1>
    {!item || item.publication === "DRAFT" ? marketIds.length === 0
      ? <p><Link href="/seller#markets">Apply for market access</Link> to save listings.</p>
      : <ListingForm key={listing?.id ?? "new"} departments={departments} listing={listing} marketIds={marketIds}/>
      : <div className="mp-section">
      <p>{item.publication === "ACTIVE" ? "Published" : "Archived"}</p><p>{item.description}</p>
      {listing?.personalization && <p className="personalization-note">
        {listing.personalization.required ? "Required personalization" : "Optional personalization"}: {listing.personalization.prompt}
      </p>}
      {shop.published && item.publication === "ACTIVE" && marketIds.filter(marketId =>
        variant?.offers.some(offer => offer.marketId === marketId)).map(marketId =>
          <p key={marketId}><Link prefetch={false} href={`/products/${item.slug}?market=${marketId}`}>
            Open the {markets[marketId].name} listing
          </Link></p>)}
    </div>}
    {stockRows.length > 0 && <section className="mp-section"><h2>Stock by dispatch location</h2>
      <ul className="mp-shop-grid">{stockRows.map(({ location, variantId, label, sku, available, active }) => <li className="mp-list-card" key={`${variantId}-${location.id}`}>
        <h3>{location.name}</h3><p>{label} · {sku}{location.marketId && ` · ${markets[location.marketId].name}`}</p>
        {location.active && location.marketId && marketIds.includes(location.marketId) && active && item?.publication !== "ARCHIVED"
          ? <SellerLocationStockForm key={available} variantId={variantId} locationId={location.id} available={available} />
          : <p>{available} available · Updates paused</p>}
      </li>)}</ul>
    </section>}
    {item && <section className="mp-section"><h2>Listing photos</h2>
      {item.images.length > 0 && <ul className="mp-photo-grid">{item.images.map(image => <li key={image.position}>
        <Image src={storefrontPath(image.src)} alt={image.alt} width={150} height={150} unoptimized/>
      </li>)}</ul>}
      {item.publication === "DRAFT" && item.images.length < 6 && <ListingPhotoForm product={item.id}/>}
      {item.publication === "DRAFT" && <p>Drafts stay private until a marketplace owner publishes the listing.</p>}
    </section>}
  </div>;
}
