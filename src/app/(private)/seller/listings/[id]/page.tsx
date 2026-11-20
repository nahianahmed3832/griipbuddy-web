import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getDb } from "@/lib/db/client";
import { storefrontPath } from "@/config/storefront-path";
import { markets } from "@/config/markets";
import { ListingForm, ListingPhotoForm, SellerLocationStockForm } from "@/components/marketplace/seller";
import { dispatchStockRelations } from "@/lib/commerce/location-inventory";
import { isMarketSelectable } from "@/lib/market-config";
import { ConnectedProductCommerce } from "@/components/connected-product-commerce";
import { SellerPageHeader } from "@/components/marketplace/seller-ui";
import { SellerListingEditor } from "@/components/marketplace/seller-listing-editor";
import { departmentAncestorPath } from "@/lib/catalog/departments";
import { currentMarket } from "@/lib/market-server";
import { listingSku, type SellerListingDraft } from "@/lib/marketplace/listing-review-input";
import { sellerListingMarkets, sellerListingReview } from "@/lib/marketplace/listing-review";
import { sellerListingWorkspace } from "@/lib/marketplace/seller-workspace";
import { sellerConnectedProductScope } from "@/lib/staff/product-workspace-commerce";
import { categoryPlacementScope } from "@/lib/staff/taxonomy-write";
import "../../../staff/(protected)/catalog/taxonomy/taxonomy.css";
import "../../../staff/(protected)/catalog/product-workspace.css";
import "../catalog-editor.css";

export const metadata = { title: "Manage listing" };

export default async function SellerListing({ params }: { params: Promise<{ id: string }> }) {
  const market = await currentMarket();
  const { shop, shopper, delegated } = await sellerListingWorkspace(market.id);
  const db = getDb();
  if (!shop || !shopper) redirect("/seller");
  const { id } = await params;
  const marketIds = shop.marketGrants.filter(grant => grant.status === "APPROVED").map(grant => grant.marketId).filter(isMarketSelectable);
  const back = <Link className="seller-button" href={`/seller/listings?market=${market.id}`} prefetch={false}>
    <ArrowLeft size={15} aria-hidden="true"/> Back to products
  </Link>;
  const canEdit = shop.published && marketIds.includes(market.id);
  const review = id === "new" ? null : await sellerListingReview(shopper.id, id, market.id);
  const reviewed = review || id !== "new" && (await sellerListingMarkets(shopper.id, id, market.id)).length > 0;
  if (delegated && id !== "new" && !review) notFound();
  if (id === "new" || reviewed) {
    const item = id === "new" ? null : await db.product.findFirst({
      where: { id, marketplaceShopId: shop.id, foundation: true },
      select: {
        name: true, description: true, departmentId: true, publication: true, active: true, slug: true,
        images: { orderBy: [{ isPrimary: "desc" }, { position: "asc" }], take: 1, select: { src: true, alt: true } },
        variants: {
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: {
            id: true, sku: true, label: true, options: true, active: true, isDefault: true,
            offers: { where: { publication: "ACTIVE", identity: { sellerId: shop.id, retiredAt: null } },
              select: { marketId: true, amountMinor: true, currency: true, eligible: true } },
          },
        },
      },
    });
    if (id !== "new" && !item) notFound();
    const primaryImage = item?.images[0] ?? null;
    const skuPrefix = listingSku(shop.id, "");
    const seed: SellerListingDraft | undefined = item ? {
      name: item.name, description: item.description, departmentId: item.departmentId, image: primaryImage,
      variants: item.variants.map(row => ({
        id: row.id, sku: row.sku.startsWith(skuPrefix) ? row.sku.slice(skuPrefix.length) : row.sku,
        label: row.label,
        options: Object.fromEntries(Object.entries(row.options ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        amountMinor: row.active ? row.offers.find(offer => offer.marketId === market.id && offer.currency === market.currency && offer.eligible)?.amountMinor ?? null : null,
        isDefault: row.isDefault, retired: !row.active,
      })),
    } : undefined;
    const live = Boolean(item?.publication === "ACTIVE" && item.active && item.variants.some(row => row.active &&
      row.offers.some(offer => offer.marketId === market.id && offer.currency === market.currency && offer.eligible)));
    const sharedLocked = item?.variants.some(row => row.offers.some(offer => offer.marketId !== market.id)) ?? false;
    const title = review?.draft.name ?? item?.name ?? "Add a listing";
    if (!item && !canEdit) return <>
      <SellerPageHeader title={title} description={`${market.name} · ${market.currency}`} actions={back}/>
      <section className="seller-panel"><p><Link href={`/seller?market=${market.id}#markets`}>Apply for market access</Link> to create listings in {market.name}.</p></section>
    </>;
    const nodes = await db.department.findMany({
      where: { state: "ACTIVE" }, select: { id: true, name: true, kind: true, parentId: true }, orderBy: { position: "asc" },
    });
    const byId = new Map(nodes.map(node => [node.id, node]));
    const leaves = await db.department.findMany({
      where: categoryPlacementScope(nodes.filter(node => node.kind === "SUBCATEGORY").map(node => node.id), false),
      select: { id: true },
    });
    const departments = leaves.flatMap(({ id }) => {
      const path = departmentAncestorPath(byId, id);
      return path ? [{ id, name: path.map(node => node.name).join(" / ") }] : [];
    }).sort((left, right) => left.name.localeCompare(right.name));
    return <>
      <SellerPageHeader title={title} description={`${market.name} · ${market.currency}`} actions={<>
        {item?.variants.length && canEdit ? <a className="seller-button" href="#inventory">Stock pools</a> : null}
        {live && canEdit && item && <Link className="seller-button" href={`/products/${item.slug}?market=${market.id}`} prefetch={false}>View listing</Link>}
        {back}
      </>}/>
      <SellerListingEditor key={`${id}-${market.id}`} productId={item ? id : undefined} review={review} seed={seed}
        departments={departments} market={market} canEdit={canEdit} live={live} archived={item?.publication === "ARCHIVED"}
        sharedLocked={sharedLocked}/>
      {item?.variants.length && canEdit ? <ConnectedProductCommerce productId={id} actorKind="seller" inventoryOnly/> : null}
    </>;
  }
  const [departments, item, connected] = await Promise.all([
    db.department.findMany({ select: { id: true, name: true }, orderBy: { position: "asc" } }),
    db.product.findFirst({ where: { id, marketplaceShopId: shop.id, foundation: false }, include: {
      images: { orderBy: { position: "asc" } }, variants: { orderBy: { position: "asc" },
        include: { ...dispatchStockRelations, offers: { where: { eligible: true, marketId: { in: marketIds } } } } },
    } }),
    db.product.findFirst({ where: { id, ...sellerConnectedProductScope(shop.id, canEdit ? [market.id] : []) },
      select: { id: true, name: true, publication: true } }),
  ]);
  if (connected) return <>
    <SellerPageHeader title={connected.name} description={`${market.name} · ${market.currency}`} actions={back}/>
    <div className="shell mp-page taxonomy-workspace connected-product-workspace">
      <p>{connected.publication === "ACTIVE" ? "Published" : connected.publication === "DRAFT" ? "Catalog draft" : "Archived"}</p>
      <nav className="taxonomy-tabs" aria-label="Product commerce sections">
        <a href="#markets">Markets and offers</a><a href="#inventory">Inventory</a>
      </nav>
      <ConnectedProductCommerce productId={connected.id} actorKind="seller" />
    </div>
  </>;
  if (!item) notFound();
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
  return <>
    <SellerPageHeader title={item?.name ?? "Add a listing"} description={`${market.name} · ${market.currency}`} actions={back}/>
    <section className="seller-panel" aria-label="Listing information">
    {item.publication === "DRAFT" ? marketIds.length === 0
      ? <p><Link href={`/seller?market=${market.id}#markets`}>Apply for market access</Link> to save listings.</p>
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
    </section>
    {stockRows.length > 0 && <section className="seller-panel"><div className="seller-panel-heading"><h2>Stock by dispatch location</h2></div>
      <ul className="mp-shop-grid">{stockRows.map(({ location, variantId, label, sku, available, active }) => <li className="mp-list-card" key={`${variantId}-${location.id}`}>
        <h3>{location.name}</h3><p>{label} · {sku}{location.marketId && ` · ${markets[location.marketId].name}`}</p>
        {location.active && location.marketId && marketIds.includes(location.marketId) && active && item?.publication !== "ARCHIVED"
          ? <SellerLocationStockForm key={available} variantId={variantId} locationId={location.id} available={available} />
          : <p>{available} available · Updates paused</p>}
      </li>)}</ul>
    </section>}
    {item && <section className="seller-panel"><div className="seller-panel-heading"><h2>Listing photos</h2></div>
      {item.images.length > 0 && <ul className="mp-photo-grid">{item.images.map(image => <li key={image.position}>
        <Image src={storefrontPath(image.src)} alt={image.alt} width={150} height={150} unoptimized/>
      </li>)}</ul>}
      {item.publication === "DRAFT" && item.images.length < 6 && <ListingPhotoForm product={item.id}/>}
      {item.publication === "DRAFT" && <p>Drafts stay private until a marketplace owner publishes the listing.</p>}
    </section>}
  </>;
}
