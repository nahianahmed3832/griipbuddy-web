'use client';

import Image from 'next/image';
import Link from 'next/link';
import { BadgeCheck, Camera, Star, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { marketHref, type CatalogProduct, type Market } from './catalog';
import type { Eligible, ReviewMedia, ReviewPage } from './reviews';

const MB = 1024 * 1024;
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });
const reviewDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : '';

function Stars({ rating }: { rating: number }) {
  return <span className="rating-stars" role="img" aria-label={rating.toFixed(1) + ' out of 5 stars'}>
    {[1, 2, 3, 4, 5].map(number => <Star key={number} size={16} aria-hidden fill={number <= Math.round(rating) ? 'currentColor' : 'none'} />)}
  </span>;
}

function Media({ file, index }: { file: ReviewMedia; index: number }) {
  return file.type === 'video' ? <video src={file.src} controls preload="none" aria-label={'Customer review video ' + (index + 1)} />
    : <a href={file.src} target="_blank" rel="noreferrer" aria-label={'Open customer photo ' + (index + 1)}>
      <Image src={file.src} alt={'Customer photo ' + (index + 1)} width={120} height={120} unoptimized loading="lazy" />
    </a>;
}

export function ProductReviews({ product, market, initial, enabled, writable }: {
  product: CatalogProduct; market: Market; initial: ReviewPage | null; enabled: boolean; writable: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const section = useRef<HTMLDetailsElement>(null);
  const [eligibility, setEligibility] = useState<Eligible | null>();
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(initial);
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState(false);
  const [listingError, setListingError] = useState('');
  const total = data?.ratings.reduce((sum, count) => sum + count, 0) ?? 0;
  const average = total ? data!.ratings.reduce((sum, count, index) => sum + count * (index + 1), 0) / total : 0;
  const gallery = data?.reviews.flatMap(review => review.media).slice(0, 6) ?? [];
  useEffect(() => {
    if (window.location.hash === '#product-reviews' && section.current) section.current.open = true;
  }, []);
  if (!enabled) return null;

  async function list(next: number, order: string) {
    setListing(true);
    setListingError('');
    try {
      const params = new URLSearchParams({ id: product.id, sort: order, page: String(next) });
      const response = await fetch('/api/reviews/list?' + params);
      if (!response.ok) throw new Error();
      setData(await response.json() as ReviewPage);
      setSort(order);
      setPage(next);
    } catch { setListingError('Could not load reviews. Try again.'); }
    finally { setListing(false); }
  }

  async function write() {
    setMessage('');
    setNeedsSignIn(false);
    dialog.current?.showModal();
    if (sent) return;
    setEligibility(undefined);
    try {
      const response = await fetch('/api/reviews/eligible?id=' + encodeURIComponent(product.id));
      if (response.status === 401) {
        setNeedsSignIn(true);
        setEligibility(null);
      } else if (response.ok) setEligibility(await response.json() as Eligible);
      else throw new Error();
    } catch {
      setEligibility(null);
      setMessage('Could not check your orders. Try again.');
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    const photos = fields.getAll('photos').filter((file): file is File => file instanceof File && file.size > 0);
    const video = fields.get('video');
    const clips = video instanceof File && video.size > 0 ? [video] : [];
    const files = [...photos, ...clips];
    if (photos.length > 3 || photos.some(photo => photo.size > 2 * MB || !['image/jpeg', 'image/png', 'image/webp'].includes(photo.type))
      || clips.some(clip => clip.size > 4 * MB || clip.type !== 'video/mp4') || files.reduce((sum, file) => sum + file.size, 0) > 5 * MB) {
      setMessage('Choose up to three JPEG, PNG or WebP photos at 2 MB each and one MP4 up to 4 MB. Keep all files under 5 MB combined.');
      return;
    }
    fields.delete('photos');
    fields.delete('video');
    fields.set('product', product.id);
    files.forEach(file => fields.append('media', file));
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/reviews/submit', { method: 'POST', body: fields });
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        throw new Error(value?.error ?? 'Could not submit your review. Try again.');
      }
      setSent(true);
    } catch (problem) {
      setMessage(problem instanceof Error ? problem.message : 'Could not submit your review.');
    } finally { setBusy(false); }
  }

  return <details className="detail-accordion review-accordion" id="product-reviews" ref={section}>
    <summary><span>Customer reviews</span>{data && <span className="review-count">{total > 0 ? <><Star size={14} fill="currentColor" aria-hidden /> {average.toFixed(1)} · {total}</> : 'No reviews yet'}</span>}</summary>
    <div className="review-panel">
      {total > 0 && <div className="review-score">
        <div><strong>{average.toFixed(1)}</strong><Stars rating={average} /><small>Based on {total} {total === 1 ? 'review' : 'reviews'}</small></div>
        <div className="review-bars">{[5, 4, 3, 2, 1].map(rating => <div key={rating}>
          <span>{rating} <Star size={11} fill="currentColor" aria-hidden /></span>
          <meter min={0} max={total} value={data!.ratings[rating - 1]} aria-label={rating + ' star reviews'} />
          <span>{data!.ratings[rating - 1]}</span>
        </div>)}</div>
      </div>}
      {gallery.length > 0 && <div className="review-gallery-wrap"><h3><Camera size={16} aria-hidden /> From customers</h3>
        <div className="review-gallery">{gallery.map((file, index) => <Media key={file.src + index} file={file} index={index} />)}</div>
      </div>}
      <div className="review-controls">
        {total > 1 && <label>Sort reviews<select value={sort} disabled={listing} onChange={event => void list(1, event.currentTarget.value)}>
          <option value="recent">Most recent</option><option value="highest">Highest rated</option><option value="lowest">Lowest rated</option>
        </select></label>}
        {writable && <button className="button button-outline" type="button" onClick={() => void write()}>Write a review</button>}
      </div>
      {data ? !total && <p>{writable ? 'Be the first to review this product after delivery.' : 'No sample reviews for this product.'}</p>
        : <button className="text-link" type="button" disabled={listing} onClick={() => void list(1, 'recent')}>Load reviews</button>}
      {listingError && <p role="alert">{listingError}</p>}
      {data?.reviews.map(review => <article className="review-entry" key={review.id}>
        <div className="review-meta"><Stars rating={review.rating} />{review.verified && <span><BadgeCheck size={15} aria-hidden /> Verified purchase</span>}</div>
        <h3>{review.title || 'Customer review'}</h3>
        <p>{review.content}</p>
        {review.media.length > 0 && <div className="review-gallery">{review.media.map((file, index) => <Media key={file.src + index} file={file} index={index} />)}</div>}
        {reviewDate(review.createdAt) && <time dateTime={review.createdAt}>{reviewDate(review.createdAt)}</time>}
      </article>)}
      {total > 10 && <div className="review-pagination">
        <button className="button button-outline" disabled={page === 1 || listing} type="button" onClick={() => void list(page - 1, sort)}>Previous</button>
        <span aria-live="polite">Page {page}</span>
        <button className="button button-outline" disabled={page * 10 >= total || listing} type="button" onClick={() => void list(page + 1, sort)}>Next</button>
      </div>}
    </div>
    {writable && <dialog ref={dialog} className="review-dialog" aria-labelledby="review-title">
      <div className="size-chart-head"><h2 id="review-title">Write a review</h2>
        <button className="icon-button" type="button" aria-label="Close review form" onClick={() => dialog.current?.close()}><X aria-hidden /></button></div>
      <div className="size-chart-body">
        {sent ? <p role="status">Review submitted. It will appear after moderation.</p>
          : needsSignIn ? <p><Link className="text-link" href={marketHref(market, '/login?next=' + encodeURIComponent('/product/' + product.slug))}>Sign in</Link> to review a delivered order.</p>
            : eligibility === undefined ? <p role="status">Checking delivered orders…</p>
              : eligibility?.reviewed ? <p>You’ve already submitted a review for this product.</p>
                : eligibility && !eligibility.orders.length ? <p>You can review a product once your order is delivered.</p>
                  : eligibility && <form className="review-form" onSubmit={submit}>
                    <label>Delivered order<select name="order" required>{eligibility.orders.map(order => <option key={order.id} value={order.id}>
                      {'Order ' + (order.number || order.id.slice(-6))}{reviewDate(order.date) && ' · ' + reviewDate(order.date)}
                    </option>)}</select></label>
                    <label>Rating<select name="rating" required defaultValue=""><option value="" disabled>Select a rating</option>
                      {[5, 4, 3, 2, 1].map(rating => <option value={rating} key={rating}>{rating} {rating === 1 ? 'star' : 'stars'}</option>)}
                    </select></label>
                    <label>Title (optional)<input name="title" maxLength={100} /></label>
                    <label>Your review<textarea name="content" rows={4} required minLength={3} maxLength={5000} /></label>
                    <p id="review-file-limits">Up to three JPEG, PNG or WebP photos at 2 MB each and one MP4 at 4 MB. Maximum 5 MB combined. Videos are muted and limited to the first 30 seconds.</p>
                    <label>Photos<input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp" aria-describedby="review-file-limits" /></label>
                    <label>Video<input type="file" name="video" accept="video/mp4" aria-describedby="review-file-limits" /></label>
                    <button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit review'}</button>
                  </form>}
        {message && <p className="checkout-error" role="alert">{message}</p>}
      </div>
    </dialog>}
  </details>;
}
