'use client';

import { Columns2, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { lowestPricedVariant } from './browse';
import { currentPrice, formatMoney, marketHref, productHref, type Market } from './catalog';
import { updateBrowserList, useBrowserList } from './browser-lists';
import { useCatalogItems } from './use-catalog-items';

const compareLimit = 3;
const keyFor = (market: Market) => 'griipbuddy-compare:' + market.code;

export function CompareButton({ market, slug, name }: { market: Market; slug: string; name: string }) {
  const key = keyFor(market);
  const { items, hydrated } = useBrowserList(key);
  const selected = items.includes(slug);
  const full = !selected && items.length >= compareLimit;

  return <button className="compare-toggle" type="button" aria-pressed={selected} disabled={!hydrated || full}
    aria-label={(selected ? 'Remove ' : 'Compare ') + name + (selected ? ' from comparison' : '')}
    title={full ? 'Remove an item to compare another product' : undefined}
    onClick={() => updateBrowserList(key, (previous) => previous.includes(slug) ? previous.filter((item) => item !== slug) : [...previous, slug].slice(0, compareLimit))}>
    <Columns2 size={14} aria-hidden /> {selected ? 'Comparing' : 'Compare'}
  </button>;
}

export function CompareLink({ market }: { market: Market }) {
  const { items } = useBrowserList(keyFor(market));
  return <Link className="button button-outline compare-link" href={marketHref(market, '/compare')}>
    <Columns2 size={16} aria-hidden /> Compare{items.length ? ' (' + items.length + ')' : ''}
  </Link>;
}

export function Comparison({ market }: { market: Market }) {
  const key = keyFor(market);
  const { items, hydrated } = useBrowserList(key);
  const { products, loading, failed } = useCatalogItems(market, items.slice(0, compareLimit));
  const missing = items.filter((slug) => !products.some((product) => product.slug === slug));
  const remove = (slug: string) => updateBrowserList(key, (previous) => previous.filter((item) => item !== slug));

  if (!hydrated || loading) return <p role="status" className="catalog-notice">Loading comparison…</p>;
  if (failed) return <p role="status" className="catalog-notice">Comparison products could not be loaded. Try refreshing.</p>;
  if (!items.length) return <div className="empty-state"><Columns2 aria-hidden /><h2>Start a comparison</h2>
    <p>Choose Compare on up to three products to see their prices and details side by side.</p>
    <Link className="button button-primary" href={marketHref(market, '/products')}>Browse products</Link></div>;

  return <>
    <div className="compare-actions">
      <Link className="text-link" href={marketHref(market, '/products')}>Browse more products</Link>
      <button type="button" className="text-link" onClick={() => updateBrowserList(key, () => [])}>Clear comparison</button>
    </div>
    {missing.length > 0 && <p className="catalog-notice">{missing.length} {missing.length === 1 ? 'item is' : 'items are'} unavailable in this market.
      <button type="button" className="text-link" onClick={() => updateBrowserList(key, (previous) => previous.filter((slug) => !missing.includes(slug)))}>Remove unavailable items</button></p>}
    <div className="comparison-grid">
      {products.map((product) => {
        const variant = lowestPricedVariant(product.variants);
        const image = variant?.images[0] ?? product.images[0];
        return <article key={product.id} className="comparison-item">
          {image && <div className="compare-image"><Image src={image} alt="" fill sizes="(max-width: 700px) 44vw, 29vw"
            unoptimized={image.startsWith('https://')} referrerPolicy="no-referrer" /></div>}
          <div><h2><Link href={productHref(market, product.slug)}>{product.name}</Link></h2>
            {variant?.price && <p className="product-price">{formatMoney(currentPrice(variant.price), market)}</p>}
            <dl>
              {product.brand && <div><dt>Brand</dt><dd>{product.brand.name}</dd></div>}
              {Object.entries(variant?.attributes ?? {}).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
              {product.specifications.map(({ title, values }, index) => <div key={title + index}><dt>{title}</dt><dd>{values.join(' · ')}</dd></div>)}
            </dl>
            <button type="button" className="button button-outline" aria-label={'Remove ' + product.name + ' from comparison'} onClick={() => remove(product.slug)}><X size={16} aria-hidden /> Remove</button>
          </div>
        </article>;
      })}
    </div>
  </>;
}
