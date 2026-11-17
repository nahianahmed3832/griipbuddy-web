import Link from "next/link";
import { notFound } from "next/navigation";
import { hybridStoreMode, marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";
import { getDb } from "@/lib/db/client";
import { storeShop } from "@/lib/marketplace/constants";
import { threadsFor } from "@/lib/marketplace/data";
import { MarketModeration, ReviewModeration, ShopModeration } from "@/components/marketplace/seller";
import { ThreadLinks } from "@/components/marketplace/messages";
import { markets } from "@/config/markets";

export const metadata = { title: "Marketplace moderation" };

export default async function MarketplaceAdmin() {
  if (!marketplaceMode()) notFound();
  const staff = await requireStaff();
  if (staff.role !== "OWNER" || !staff.marketIds.includes("bd") || !staff.marketIds.includes("us")) notFound();
  const hybrid = hybridStoreMode();
  const db = getDb();
  const [shops, reviews, inbox] = await Promise.all([
    db.marketplaceShop.findMany({ where: { id: { not: storeShop.id } }, orderBy: { createdAt: "desc" }, take: 50,
      select: { id: true, slug: true, name: true, about: true, published: true, marketGrants: true, listings: {
        orderBy: { addedOn: "desc" }, take: 30, select: { id: true, name: true, publication: true },
      } } }),
    db.shopperReview.findMany({ orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, visible: true, stars: true, text: true,
      product: { select: { name: true, slug: true } } } }),
    threadsFor(staff.id, storeShop.id),
  ]);
  return <>
    <div className="commerce-intro"><h1 className="display-type">Marketplace moderation</h1></div>
    <section className="mp-section"><h2>Seller shops and listings</h2>
      {shops.length === 0 ? <p>No seller shops yet.</p> : <ul className="mp-shop-grid">{shops.map(shop => <li className="mp-list-card" key={shop.id}>
        <strong>{shop.name} · {shop.published ? "Public" : "Private"}</strong><p>{shop.about}</p>
        {shop.published && (hybrid ? shop.marketGrants.filter(grant => grant.status === "APPROVED").map(({ marketId }) =>
          <p key={marketId}><Link href={marketId === "bd" ? `/bd/shops/${shop.slug}` : `/shops/${shop.slug}?market=us`}>
            Visit {markets[marketId].name} shop
          </Link></p>) : <Link href={`/shops/${shop.slug}`}>Visit shop</Link>)}
        <ShopModeration shop={shop.id} published={shop.published}/>
        {hybrid && <MarketModeration shop={shop.id} grants={shop.marketGrants}/>}
        <ul className="mp-editor-list">{shop.listings.map(item => <li key={item.id}><Link href={`/staff/catalog/products/${item.id}`}>{item.name} · {item.publication}</Link></li>)}</ul>
      </li>)}</ul>}
    </section>
    <section className="mp-section"><h2>Reviews</h2>
      {reviews.length === 0 ? <p>No reviews yet.</p> : <ul className="mp-shop-grid">{reviews.map(review => <li className="mp-list-card" key={review.id}>
        <strong>{review.stars}/5 · {review.product.name}</strong><p>{review.text}</p><ReviewModeration review={review.id} visible={review.visible}/>
      </li>)}</ul>}
    </section>
    <section className="mp-section"><h2>GriipBuddy shop inbox</h2><ThreadLinks rows={inbox}/></section>
  </>;
}
