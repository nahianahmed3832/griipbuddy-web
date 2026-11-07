'use client';

import Link from 'next/link';
import { Heart } from 'lucide-react';
import { useEffect, useState } from 'react';
import { marketHref, type Market } from './catalog';
import { updateBrowserList, useBrowserList } from './browser-lists';
import { ProductCard } from './product-card';
import { useWishlist } from './wishlist';
import { SavedCollections } from './collections-local';
import { useCatalogItems } from './use-catalog-items';

const recentKey = 'griipbuddy-storefront-recently-viewed';

export function WishlistPage({ market }: { market: Market }) {
  const { saved, hydrated, readOnly, error } = useWishlist();
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(saved.length / 24));
  const current = Math.min(page, pages);
  const { products, loading, failed } = useCatalogItems(market, saved.slice((current - 1) * 24, current * 24));
  if (!hydrated || loading) return <p role="status" className="catalog-notice">Loading your wishlist…</p>;
  if (failed) return <p role="status" className="catalog-notice">Your saved products could not be loaded. Try refreshing.</p>;

  return (
    <>
      {readOnly && <p className="catalog-notice">Saved products from your recovered account are available to view.</p>}
      {error && <p role="status" className="catalog-notice">{error}</p>}
      {products.length > 0 ? <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} market={market} />)}</div>
        : <div className="empty-state">
          <Heart size={30} aria-hidden /><h2>No saved items in this market</h2>
          <p>Tap the heart on something you love to find it here later.</p>
          <Link className="button button-primary" href={marketHref(market, '/collections/new-arrivals')}>Explore new arrivals</Link>
        </div>}
      <SavedCollections market={market} />
      {pages > 1 && <div className="catalog-pagination">
        <button type="button" className="button button-outline" disabled={current === 1} onClick={() => setPage(current - 1)}>Previous</button>
        <span>Page {current} of {pages}</span>
        <button type="button" className="button button-outline" disabled={current === pages} onClick={() => setPage(current + 1)}>Next</button>
      </div>}
    </>
  );
}

export function RecentlyViewed({ market, slug }: { market: Market; slug: string }) {
  const { items: history } = useBrowserList(recentKey);
  const { products } = useCatalogItems(market, history.filter((entry) => entry !== slug).slice(0, 4));

  useEffect(() => {
    updateBrowserList(recentKey, (previous) => [slug, ...previous.filter((entry) => entry !== slug)].slice(0, 16));
  }, [slug]);

  if (!products.length) return null;
  return <section className="product-shelf" aria-label="Recently viewed">
    <h2>Recently viewed</h2>
    <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} market={market} />)}</div>
  </section>;
}

export function ShoppingHistory({ market }: { market: Market }) {
  const { items } = useBrowserList(recentKey);
  const { products } = useCatalogItems(market, items.slice(0, 4));
  if (!products.length) return null;
  return <section className="home-panel home-product-shelf" aria-label="Pick up where you left off">
    <div className="market-section-heading">
      <div><p className="eyebrow">YOUR BROWSING HISTORY</p><h2>Pick up where you left off</h2></div>
      <button type="button" className="text-link" onClick={() => updateBrowserList(recentKey, () => [])}>Clear history</button>
    </div>
    <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} market={market} />)}</div>
  </section>;
}
