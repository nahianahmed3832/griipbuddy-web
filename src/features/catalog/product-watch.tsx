'use client';

import { Bell, X } from 'lucide-react';
import Link from 'next/link';
import { updateBrowserList, useBrowserList } from './browser-lists';
import { formatMoney, currentPrice, productHref, type Market } from './catalog';
import { lowestPricedVariant } from './browse';
import { useCatalogItems } from './use-catalog-items';

const watchKey = (market: Market) => 'griipbuddy-watchlist:' + market.code;

export function WatchButton({ slug, market }: { slug: string; market: Market }) {
  const key = watchKey(market);
  const { items, hydrated } = useBrowserList(key);
  const saved = items.includes(slug);
  return <button type="button" className="button button-outline" aria-pressed={saved} disabled={!hydrated || (!saved && items.length >= 30)}
    onClick={() => updateBrowserList(key, (previous) => saved ? previous.filter((entry) => entry !== slug) : [slug, ...previous].slice(0, 30))}>
    <Bell size={16} aria-hidden />{saved ? 'Remove from watchlist' : 'Add to watchlist'}
  </button>;
}

export function ProductWatchlist({ market }: { market: Market }) {
  const key = watchKey(market);
  const { items } = useBrowserList(key);
  const { products, loading, failed } = useCatalogItems(market, items);
  if (!items.length) return null;
  return <section className="watchlist-panel" aria-label="Product watchlist">
    <div className="market-section-heading"><div><p className="eyebrow">SAVED ON THIS DEVICE</p><h2>Your watchlist</h2></div></div>
    <p>Check current prices here. Automatic price-drop and restock notifications are unavailable.</p>
    {loading && <p role="status">Loading watchlist…</p>}
    {failed && <p role="status">Could not load the watchlist. Try refreshing.</p>}
    {!loading && !failed && <ul>{items.map((slug) => {
      const product = products.find((item) => item.slug === slug);
      const price = product && lowestPricedVariant(product.variants)?.price;
      return <li key={slug}>
        {product ? <Link href={productHref(market, slug)}>{product.name}</Link> : <span>Unavailable product</span>}
        {price && <strong>{formatMoney(currentPrice(price), market)}</strong>}
        <button type="button" className="icon-button" aria-label={'Remove ' + (product?.name ?? slug) + ' from watchlist'}
          onClick={() => updateBrowserList(key, (previous) => previous.filter((entry) => entry !== slug))}><X aria-hidden /></button>
      </li>;
    })}</ul>}
  </section>;
}
