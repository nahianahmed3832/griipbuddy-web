'use client';

import { ImageIcon, Minus, Plus, X, ZoomIn } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { currentPrice, formatMoney, productBadges, type CatalogProduct, type CatalogVariant, type Market } from './catalog';
import { WishlistButton } from './wishlist';
import { AddToBag } from '@/features/cart/actions';

function Gallery({ images, product }: { images: string[]; product: string }) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const image = images[active];

  if (!image) return <div className="gallery-main catalog-image-empty"><ImageIcon aria-hidden size={34} /><span>Image unavailable</span></div>;

  return (
    <div className="product-gallery">
      <button className="gallery-main" type="button" aria-label={'Zoom image ' + (active + 1)}
        onClick={() => { setOpen(true); setZoomed(false); dialog.current?.showModal(); }}>
        <Image src={image} fill priority={active === 0} unoptimized={image.startsWith('https://')} referrerPolicy="no-referrer" alt={product + ' — image ' + (active + 1)}
          sizes="(max-width: 760px) 92vw, 46vw" />
        <span className="gallery-zoom"><ZoomIn size={19} aria-hidden /></span>
      </button>
      {images.length > 1 && <div className="gallery-thumbs" aria-label="Product images">
        {images.map((src, index) => <button key={src} type="button" onClick={() => setActive(index)}
          aria-label={'Show image ' + (index + 1)} aria-pressed={active === index}>
          <Image src={src} fill unoptimized={src.startsWith('https://')} referrerPolicy="no-referrer" alt="" sizes="76px" />
        </button>)}
      </div>}
      <dialog ref={dialog} className="zoom-dialog" aria-label="Product image zoom" onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="zoom-toolbar">
          <button className="icon-button" type="button" aria-label={zoomed ? 'Zoom out' : 'Zoom in'}
            aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>{zoomed ? <Minus aria-hidden /> : <Plus aria-hidden />}</button>
          <button className="icon-button" type="button" aria-label="Close image zoom" onClick={() => dialog.current?.close()}><X aria-hidden /></button>
        </div>
        <div className="zoom-scroll">
          <div className={'zoom-image' + (zoomed ? ' is-magnified' : '')}>
            {open && <Image src={image} fill unoptimized={image.startsWith('https://')} referrerPolicy="no-referrer" alt={product + ' — enlarged image'} sizes="(max-width: 760px) 100vw, 1050px" />}
          </div>
        </div>
      </dialog>
    </div>
  );
}

function variantDimensions(variants: CatalogVariant[]) {
  const dimensions = new Map<string, { title: string; values: Set<string> }>();
  for (const variant of variants) {
    for (const [title, value] of Object.entries(variant.attributes)) {
      const key = title.toLowerCase().replace(/^colour$/, 'color');
      const dimension = dimensions.get(key) ?? { title, values: new Set<string>() };
      dimension.values.add(value);
      dimensions.set(key, dimension);
    }
  }
  return [...dimensions];
}

function valuesFor(variant?: CatalogVariant) {
  return new Map(Object.entries(variant?.attributes ?? {}).map(([key, value]) => [key.toLowerCase().replace(/^colour$/, 'color'), value]));
}

function chooseVariant(variants: CatalogVariant[], selected: CatalogVariant | undefined, dimension: string, value: string) {
  const current = valuesFor(selected);
  const candidates = variants.filter((variant) => valuesFor(variant).get(dimension) === value);
  function score(variant: CatalogVariant) {
    const values = valuesFor(variant);
    return [...current].filter(([key, value]) => key !== dimension && values.get(key) === value).length;
  }
  return candidates.reduce<CatalogVariant | undefined>((best, variant) => (
    !best || score(variant) > score(best) || (score(variant) === score(best) && variant.price && !best.price) ? variant : best
  ), undefined);
}

export function ProductExperience({ product, market, initialId, initialStock }: {
  product: CatalogProduct; market: Market; initialId?: string; initialStock: number | null;
}) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [reply, setReply] = useState<{ id: string; stock: number | null }>();
  const selected = product.variants.find((variant) => variant.id === selectedId);
  const price = selected?.price;
  const knownStock = reply?.id === selectedId ? reply?.stock : selectedId === initialId ? initialStock : undefined;
  const availability = !price ? 'Unavailable in this market'
    : knownStock === undefined ? 'Checking availability…'
      : knownStock === null ? 'Availability unavailable'
        : knownStock > 0 ? 'In stock · ' + knownStock + ' available' : 'Out of stock';
  const badges = productBadges({
    ...product, variants: selected ? [selected] : [],
    availability: price && knownStock === 0 ? 'out' : undefined,
  });
  const images = [...new Set([...(selected?.images ?? []), ...product.images])];
  const dimensions = variantDimensions(product.variants);
  const current = valuesFor(selected);

  useEffect(() => {
    if (!selectedId || !price || selectedId === initialId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ market: market.code, product: product.slug, variant: selectedId });
    fetch('/api/catalog/stock?' + params, { signal: controller.signal })
      .then(async (response) => response.ok ? (await response.json() as { stock: number | null }).stock : null)
      .then((stock) => { if (!controller.signal.aborted) setReply({ id: selectedId, stock }); })
      .catch(() => { if (!controller.signal.aborted) setReply({ id: selectedId, stock: null }); });
    return () => controller.abort();
  }, [initialId, market.code, price, product.slug, selectedId]);

  function select(dimension: string, value: string) {
    const next = chooseVariant(product.variants, selected, dimension, value);
    if (!next || next.id === selectedId) return;
    setSelectedId(next.id);
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next.id);
    window.history.replaceState(null, '', url);
  }

  return (
    <div className="detail-grid">
      <Gallery key={selectedId ?? product.id} images={images} product={product.name} />
      <div className="detail-copy">
        {product.brand && <p className="eyebrow">{product.brand.name}</p>}
        <h1>{product.name}</h1>
        {badges.length > 0 && <ul className="detail-badges" aria-label="Product badges">
          {badges.map((badge) => <li data-badge={badge} key={badge}>{badge}</li>)}
        </ul>}
        <div className="detail-market" aria-live="polite">
          {price && <p className="detail-price">{formatMoney(currentPrice(price), market)}
            {price.sale !== undefined && <del>{formatMoney(price.regular, market)}</del>}
          </p>}
          <p className="detail-stock" data-stock={knownStock === 0 ? 'out' : knownStock && price ? 'in' : 'unknown'}>{availability}</p>
          {(selected?.sku || product.sku) && <p className="detail-sku">SKU <span>{selected?.sku || product.sku}</span></p>}
        </div>
        {product.description && <p className="detail-description">{product.description}</p>}
        {dimensions.length > 0 && <div className="variant-groups">
          {dimensions.map(([key, { title, values }]) => <fieldset key={key} className="variant-group">
            <legend>{title}{current.get(key) && <span> · {current.get(key)}</span>}</legend>
            <div>{[...values].map((value) => <button type="button" key={value} className="variant-option"
              aria-label={title + ': ' + value} aria-pressed={current.get(key) === value}
              onClick={() => select(key, value)}>{value}</button>)}</div>
          </fieldset>)}
        </div>}
        <AddToBag key={selectedId ?? product.id} product={product} variant={selected} stock={knownStock} />
        {price && <WishlistButton slug={product.slug} name={product.name} className="button button-outline detail-wish" showLabel />}
        {product.specifications.length > 0 && <details className="product-specifications">
          <summary>Specifications</summary>
          <dl>{product.specifications.map(({ title, values }, index) => <div key={title + index}><dt>{title}</dt><dd>{values.join(' · ')}</dd></div>)}</dl>
        </details>}
      </div>
    </div>
  );
}
