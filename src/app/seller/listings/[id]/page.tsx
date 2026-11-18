import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hybridStoreMode, marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { getDb } from "@/lib/db/client";
import { storefrontPath } from "@/config/storefront-path";
import { markets } from "@/config/markets";
import { ListingForm, ListingPhotoForm, ListingVideoForm } from "@/components/marketplace/seller";

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
  const hybrid = hybridStoreMode();
  const marketIds = hybrid ? shop.marketGrants.map(grant => grant.marketId) : undefined;
  const [departments, item] = await Promise.all([
    db.department.findMany({ select: { id: true, name: true }, orderBy: { position: "asc" } }),
    id === "new" ? null : db.product.findFirst({ where: { id, marketplaceShopId: shop.id }, include: {
      images: { orderBy: { position: "asc" } }, variants: { orderBy: { position: "asc" },
        include: { inventory: true, offers: { where: hybrid ? { eligible: true } : { marketId: "bd" } } } },
    } }),
  ]);
  if (id !== "new" && !item) notFound();
  const variant = item?.variants[0];
  const listing = item && variant ? { id, name: item.name, description: item.description, departmentId: item.departmentId,
    tags: item.keywords.join(", "), sku: variant.sku.replace(/^M[0-9A-F]{10}-/, ""), amount: ((variant.offers[0]?.amountMinor ?? 0) / 100).toFixed(2),
    marketPrices: Object.fromEntries(variant.offers.map(offer => [offer.marketId, (offer.amountMinor / 100).toFixed(2)])),
    quantity: variant.inventory?.available ?? 0,
    personalization: item.personalizationPrompt ? { prompt: item.personalizationPrompt, required: item.personalizationRequired } : undefined,
  } : undefined;
  return <div className="shell mp-page">
    <Link href="/seller" className="text-link">Back to Shop Manager</Link>
    <h1 className="mp-page-title">{item?.name ?? "Add a listing"}</h1>
    {!item || item.publication === "DRAFT" ? marketIds?.length === 0
      ? <p><Link href="/seller#markets">Apply for market access</Link> to save listings.</p>
      : <ListingForm key={listing?.id ?? "new"} departments={departments} listing={listing} marketIds={marketIds}/>
      : <div className="mp-section">
      <p>{item.publication === "ACTIVE" ? "Published" : "Archived"}</p><p>{item.description}</p>
      {listing?.personalization && <p className="personalization-note">
        {listing.personalization.required ? "Required personalization" : "Optional personalization"}: {listing.personalization.prompt}
      </p>}
      {shop.published && item.publication === "ACTIVE" && (marketIds ? marketIds.filter(marketId =>
        variant?.offers.some(offer => offer.marketId === marketId)).map(marketId =>
          <p key={marketId}><Link href={marketId === "bd" ? `/bd/products/${item.slug}` : `/products/${item.slug}?market=us`}>
            Open the {markets[marketId].name} listing
          </Link></p>) : <Link href={`/products/${item.slug}`}>Open the public listing</Link>)}
    </div>}
    {item && <section className="mp-section"><h2>Listing photos</h2>
      {item.images.length > 0 && <ul className="mp-photo-grid">{item.images.map(image => <li key={image.position}>
        <Image src={storefrontPath(image.src)} alt={image.alt} width={150} height={150} unoptimized/>
      </li>)}</ul>}
      {item.publication === "DRAFT" && item.images.length < 6 && <ListingPhotoForm product={item.id}/>}
      {item.publication === "DRAFT" && <p>Drafts stay private until a marketplace owner publishes the listing.</p>}
    </section>}
    {item?.publication === "DRAFT" && <section className="mp-section">
      <h2>Listing videos</h2>
      <p>Use an MP4 up to 4 MB. A variant video appears first for its option. The listing video is shared across other options.</p>
      <ListingVideoForm product={item.id} label="Product video" src={item.videoUrl} />
      {item.variants.filter(option => option.active && (option.videoUrl || Object.keys(option.options ?? {}).length > 0)).map(option =>
        <ListingVideoForm key={option.id} product={item.id} variant={option.id} label={`${option.label} video`} src={option.videoUrl} />)}
    </section>}
  </div>;
}
