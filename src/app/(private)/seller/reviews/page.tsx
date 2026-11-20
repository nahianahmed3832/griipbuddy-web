import { notFound } from "next/navigation";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { resolveSellerAccess } from "@/lib/marketplace/seller-access";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Product reviews", robots: { index: false, follow: false } };

export default async function SellerReviewsPage() {
  const [shopper, market] = await Promise.all([getShopper(), currentMarket()]);
  if (!shopper) notFound();
  const result = await getDb().$transaction(async tx => {
    const access = await resolveSellerAccess(shopper.id, market.id, "LISTINGS", undefined, tx);
    if (!access) return null;
    const reviews = await tx.$queryRaw<{ id: string; stars: number; text: string; createdAt: Date; name: string }[]>`
      SELECT r.id, r.stars, r.text, r."createdAt", p.name
      FROM "ShopperReview" r
      JOIN "Product" p ON p.id = r."productId"
      JOIN "Order" o ON o.id = r."orderId"
      WHERE r.visible AND p."marketplaceShopId" = ${access.shop.id}::uuid AND o."marketId" = ${market.id}::"MarketCode"
        AND o.status = 'PLACED' AND o."fulfillmentStatus" = 'DELIVERED'
        AND EXISTS (
          SELECT 1 FROM "OrderItem" i
          JOIN "Variant" v ON v.id = i."variantId"
          WHERE i."orderId" = o.id AND i."marketplaceShopId" = ${access.shop.id}::uuid AND v."productId" = p.id
        )
      ORDER BY r."createdAt" DESC, r.id DESC LIMIT 50
    `;
    return { shop: access.shop, reviews };
  }, { isolationLevel: "RepeatableRead" });
  if (!result) notFound();
  const { shop, reviews } = result;
  return <section className="seller-panel">
    <h1 className="display-type">Product reviews</h1>
    <p>Published purchase reviews for {shop.name} in {market.name}.</p>
    {reviews.length ? <ul className="mp-shop-grid">{reviews.map(review => <li className="mp-list-card" key={review.id}>
      <strong>{review.name} · {review.stars} out of 5</strong>
      <p>{review.text}</p>
      <time dateTime={review.createdAt.toISOString()}>
        {new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeZone: market.timeZone }).format(review.createdAt)}
      </time>
    </li>)}</ul> : <p>No published purchase reviews in this market.</p>}
  </section>;
}
