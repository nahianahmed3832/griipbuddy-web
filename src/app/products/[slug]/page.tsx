import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ProductDetail } from "@/components/product-detail";
import { ProductGrid } from "@/components/product-grid";
import { Breadcrumbs, SectionHeading } from "@/components/store-ui";
import type { SearchParams } from "@/lib/catalog/listing";
import { deviceModelsByVariant } from "@/lib/catalog/devices";
import { catalog, listAddOnCandidates, relatedProductCards } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl, firstPartyStoreMode, hybridDemoMode } from "@/lib/release-config";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { merchantProductUrl } from "@/lib/catalog/merchant-fields";
import { isMerchantBdPreviewProduct, merchantBdPreviewPageProduct } from "@/lib/catalog/merchant-bd-preview";
import { devLiveBangladeshFeed, merchantFeedSettings } from "@/lib/catalog/merchant-feed-config";
import { productMetadata } from "@/lib/catalog/product-metadata";
import type { CatalogProduct } from "@/lib/catalog/types";
import { productReviews } from "@/lib/marketplace/data";
import { RecentlyViewedProduct } from "@/components/marketplace/recent";
import type { ProductAddOn } from "@/components/retail-product";
import { getDb } from "@/lib/db/client";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> };

const productForPage = cache(async (slug: string, marketId: MarketId) => {
  const product = await catalog.getProduct(slug, marketId);
  if (product && marketId === "bd" && devLiveBangladeshFeed() && isMerchantBdPreviewProduct(product)) {
    return merchantBdPreviewPageProduct(product, merchantFeedSettings(marketId));
  }
  return product;
});

function approvedMetadata(product: CatalogProduct, marketId: MarketId) {
  const path = `/products/${product.slug}`;
  const canonical = canonicalUrl(path);
  const origin = canonical ?? process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3100";
  const address = merchantProductUrl(origin, product.slug, marketId, hybridDemoMode());
  return { canonical, ...productMetadata(product, address) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [market, { slug }] = await Promise.all([currentMarket(), params]);
  const product = await productForPage(slug, market.id);
  if (!product) return { title: "Product not found" };
  const { title, description, canonical, images } = approvedMetadata(product, market.id);
  return { title, description, alternates: { canonical }, openGraph: { title, description, images } };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const [market, { slug }, query] = await Promise.all([currentMarket(), params, searchParams]);
  const [product, departments] = await Promise.all([productForPage(slug, market.id), catalog.listDepartments()]);
  if (!product) notFound();
  const department = departments.find((item) => item.id === product.departmentId);
  const hybrid = hybridDemoMode();
  const firstParty = firstPartyStoreMode();
  const fits = firstParty || hybrid ? deviceModelsByVariant(product) : [];
  const modelsByVariant = Object.fromEntries(fits.map(({ variant, models }) =>
    [variant.id, models.map(({ id, name }) => ({ id, name }))]));
  const matchModels = new Set(fits.flatMap(({ variant, models }) => variant.offer ? models.map(model => model.id) : []));
  const curatedAddOns = new Set(product.keywords.filter(tag => tag.startsWith("add-on:")).map(tag => tag.slice("add-on:".length).trim()));
  const compatibleDepartments = new Set(matchModels.size ? departments.filter(item => /protector|accessor/.test(item.slug)).map(item => item.id) : []);
  const departmentHref = department && marketStoreHref(`/departments/${department.slug}`, hybrid ? market.id : undefined);
  const db = getDb();
  const [cards, reviews, sold, ratings, addOnPool] = await Promise.all([
    relatedProductCards(market.id, product.departmentId, product.id),
    product.shop ? productReviews(product.id) : [],
    hybrid ? db.orderItem.aggregate({ where: { variant: { productId: product.id }, order: {
      marketId: market.id, status: "PLACED", payment: { status: { in: ["PAID", "COLLECTED"] } },
    } }, _sum: { quantity: true } }) : null,
    hybrid ? db.shopperReview.groupBy({ by: ["stars"], where: { productId: product.id, visible: true }, _count: true }) : [],
    hybrid ? listAddOnCandidates(market.id, product, [...compatibleDepartments], [...curatedAddOns]) : [],
  ]);
  const initialVariantId = typeof query.variant === "string" ? product.variants.find((variant) => variant.id === query.variant)?.id : undefined;
  const { markup } = approvedMetadata(product, market.id);
  const addOns: ProductAddOn[] = [];
  for (const candidate of addOnPool) {
    if (candidate.personalization?.required) continue;
    const curated = curatedAddOns.has(candidate.slug);
    if (!curated && !compatibleDepartments.has(candidate.departmentId)) continue;
    const variant = curated
      ? candidate.variants.find(item => (item.offer?.stock ?? 0) > 0)
      : deviceModelsByVariant(candidate)
        .find(({ variant, models }) => (variant.offer?.stock ?? 0) > 0 && models.some(model => matchModels.has(model.id)))?.variant;
    if (!variant?.offer) continue;
    const image = variant.image ?? candidate.images[0];
    if (!image) continue;
    addOns.push({ variantId: variant.id, name: candidate.name, slug: candidate.slug,
      image, priceMinor: variant.offer.amountMinor, stock: variant.offer.stock });
    if (addOns.length === 3) break;
  }
  const ratingCount = ratings.reduce((sum, row) => sum + row._count, 0);
  const ratingAverage = ratingCount ? ratings.reduce((sum, row) => sum + row.stars * row._count, 0) / ratingCount : 0;
  return (
    <div className="shell inner-page">
      {markup && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(markup).replace(/</g, "\\u003c") }} />}
      <Breadcrumbs items={[...(department && departmentHref ? [{ label: department.name, href: departmentHref }] : []), { label: product.name }]} />
      <ProductDetail key={`${market.id}:${product.id}:${initialVariantId ?? ""}`} product={product} market={market} initialVariantId={initialVariantId}
        departmentName={department?.shortName ?? "Catalog"} firstParty={firstParty} hybrid={hybrid}
        sales={sold?._sum.quantity ?? 0} addOns={addOns} modelsByVariant={modelsByVariant} />
      {product.shop && <>
        <RecentlyViewedProduct id={product.id}/>
        <section className="mp-reviews" aria-labelledby="listing-reviews"><h2 id="listing-reviews">Reviews for this item</h2>
          {ratingCount > 0 && <div className="retail-rating">
            <div><strong>{ratingAverage.toFixed(1)} out of 5</strong><span>{ratingCount} {ratingCount === 1 ? "review" : "reviews"}</span></div>
            <ul>{[5, 4, 3, 2, 1].map(stars => {
              const count = ratings.find(row => row.stars === stars)?._count ?? 0;
              return <li key={stars}><span aria-hidden="true">{stars} ★</span>
                <meter value={count} max={ratingCount} aria-label={`${count} ${stars}-star reviews`}/><span aria-hidden="true">{count}</span></li>;
            })}</ul>
          </div>}
          {!reviews.length && <p>No reviews yet.</p>}
          {reviews.map(review => <article className="mp-review" key={review.id}>
            <p aria-label={`${review.stars} out of 5 stars`}>{"★".repeat(review.stars)}{"☆".repeat(5 - review.stars)}</p>
            <strong>{review.shopper.name}</strong><p>{review.text}</p>
          </article>)}
        </section>
      </>}
      {cards.length > 0 && (
        <section className="home-section" aria-labelledby="related-heading">
          <SectionHeading id="related-heading" title="More to explore" action={department && departmentHref ? { href: departmentHref, label: `Shop ${department.shortName}` } : undefined} />
          <ProductGrid cards={cards} market={market} regional={hybrid} />
        </section>
      )}
    </div>
  );
}
