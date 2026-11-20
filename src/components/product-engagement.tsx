import Link from "next/link";
import type { Market } from "@/config/markets";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import type { SearchParams } from "@/lib/catalog/listing";
import { reportFailure } from "@/lib/db/observability";
import { productQuestionShop, productReviews, reviewPage, reviewSorts, type ReviewSort } from "@/lib/marketplace/product-engagement";
import { marketConfiguration } from "@/lib/market-config";
import { hybridDemoMode } from "@/lib/release-config";
import { MessageShop } from "./marketplace/messages";
import styles from "./product-discovery.module.css";

type Product = { id: string; name: string; slug: string };

export async function ProductReviews({ product, market, query }: { product: Product; market: Market; query: SearchParams }) {
  const sort = reviewSorts.find(([key]) => key === query.reviewSort)?.[0] ?? "latest";
  const reviews = await productReviews(product.id, market.id, sort, reviewPage(query.reviewPage)).catch(error => {
    reportFailure("storefront.product-reviews", undefined, error);
    return null;
  });
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  function reviewHref(nextSort: ReviewSort, page: number) {
    const params = new URLSearchParams();
    for (const key of ["variant", "category", "option", "browse"]) {
      const value = query[key];
      for (const entry of (Array.isArray(value) ? value : value ? [value] : []).slice(0, 24)) params.append(key, entry);
    }
    if (nextSort !== "latest") params.set("reviewSort", nextSort);
    if (page > 1) params.set("reviewPage", String(page));
    return catalogBrowseHref(`/products/${encodeURIComponent(product.slug)}`, context, params) + "#product-reviews";
  }
  return <section className={styles.reviews} id="product-reviews" aria-labelledby="product-reviews-heading">
    <h2 id="product-reviews-heading">Customer reviews</h2>
    {!reviews ? <p role="status">Reviews are temporarily unavailable. <Link href={reviewHref(sort, 1)} prefetch={false}>Try again</Link></p>
      : !reviews.total ? <p>No published reviews in {market.name}.</p>
      : <>
        <p><strong>{reviews.average?.toLocaleString(market.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} out of 5</strong>
          {" · "}{reviews.total.toLocaleString(market.locale)} verified {reviews.total === 1 ? "review" : "reviews"}</p>
        <nav className={styles.reviewPager} aria-label="Sort reviews">{reviewSorts.map(([key, label]) =>
          <Link key={key} href={reviewHref(key, 1)} aria-current={sort === key ? "page" : undefined} prefetch={false}>{label}</Link>)}</nav>
        {reviews.entries.map(review => <article className={styles.reviewRow} key={review.id}>
          <p><strong>{review.stars} out of 5</strong> · Verified purchase</p>
          <p>{review.text}</p>
          <time dateTime={review.createdAt.toISOString()}>
            {new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeZone: marketConfiguration(market.id).timeZone }).format(review.createdAt)}
          </time>
        </article>)}
        {reviews.pages > 1 && <nav className={styles.reviewPager} aria-label="Review pages">
          {reviews.page > 1 && <Link href={reviewHref(sort, reviews.page - 1)} prefetch={false}>Previous reviews</Link>}
          <span>Page {reviews.page} of {reviews.pages}</span>
          {reviews.page < reviews.pages && <Link href={reviewHref(sort, reviews.page + 1)} prefetch={false}>More reviews</Link>}
        </nav>}
      </>}
    <Link className="text-link" href={catalogBrowseHref("/orders", context)} prefetch={false}>Review a delivered purchase</Link>
  </section>;
}

export async function ProductQuestion({ product, market }: { product: Product; market: Market }) {
  const shop = await productQuestionShop(product.id, market.id).catch(error => {
    reportFailure("storefront.product-question", undefined, error);
    return null;
  });
  if (!shop) return null;
  return <section className={styles.question} aria-labelledby="question-heading">
    <h2 id="question-heading">Questions about this item</h2>
    <p>Ask {shop.name} a private question. Replies appear in your conversations.</p>
    <MessageShop shop={shop.id} shopName={shop.name} product={product.id} productName={product.name}
      questionMarket={{ id: market.id, locale: market.locale, regional: hybridDemoMode() }} />
  </section>;
}
