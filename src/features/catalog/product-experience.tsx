'use client';

import { Check, ChevronLeft, ChevronRight, ImageIcon, Minus, PackageCheck, Plus, X, ZoomIn } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { currentPrice, formatMoney, formatUnitsSold, productBadges, productHref, type CatalogProduct, type CatalogVariant, type Market } from './catalog';
import { WishlistButton } from './wishlist';
import { ShareLink } from '@/features/discovery/interactions';
import { DeliveryDetails } from './delivery-details';
import { CatalogImage } from './catalog-image';
import { ProductVideos } from './product-videos';
import { WatchButton } from './product-watch';
import { SaveToCollection } from './collections-local';
import { AddToBag } from '@/features/cart/actions';
import { FamilySelector, ProductAddons, SizeChart } from './product-options';
import { ProductReviews } from './product-reviews';
import type { merchandising } from './merchandising';
import type { ReviewPage } from './reviews';

function Gallery({ images, product }: { images: string[]; product: string }) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const image = images[active];
  const zoomScroll = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const ignoreTap = useRef(false);

  function step(direction: number) {
    setActive(current => (current + direction + images.length) % images.length);
    setZoomed(false);
    zoomScroll.current?.scrollTo(0, 0);
  }

  if (!image) return <div className="gallery-main catalog-image-empty"><ImageIcon aria-hidden size={34} /><span>Image unavailable</span></div>;

  return (
    <div className="product-gallery">
      <div className="gallery-stage">
        <button className="gallery-main" type="button" aria-label={'Zoom image ' + (active + 1)}
          onTouchStart={event => {
            const { clientX: x, clientY: y } = event.touches[0];
            swipeStart.current = event.touches.length === 1 ? { x, y } : null;
            ignoreTap.current = false;
          }}
          onTouchCancel={() => { swipeStart.current = null; }}
          onTouchEnd={event => {
            if (images.length < 2 || swipeStart.current === null) return;
            const delta = event.changedTouches[0].clientX - swipeStart.current.x;
            const vertical = event.changedTouches[0].clientY - swipeStart.current.y;
            if (Math.abs(delta) > 45 && Math.abs(delta) > Math.abs(vertical)) { ignoreTap.current = true; step(delta < 0 ? 1 : -1); }
            swipeStart.current = null;
          }}
          onClick={event => {
            if (ignoreTap.current && event.detail) { ignoreTap.current = false; return; }
            setOpen(true); setZoomed(false); dialog.current?.showModal();
          }}>
          <CatalogImage key={image} src={image} fill priority={active === 0} alt={product + ' — image ' + (active + 1)}
            sizes="(max-width: 760px) 92vw, 46vw" />
          <span className="gallery-zoom"><ZoomIn size={19} aria-hidden /></span>
        </button>
        {images.length > 1 && <div className="gallery-controls">
          <button type="button" className="icon-button" aria-label="Previous image" onClick={() => step(-1)}><ChevronLeft aria-hidden /></button>
          <span aria-live="polite">{active + 1} / {images.length}</span>
          <button type="button" className="icon-button" aria-label="Next image" onClick={() => step(1)}><ChevronRight aria-hidden /></button>
        </div>}
      </div>
      {images.length > 1 && <div className="gallery-thumbs" aria-label="Product images">
        {images.map((src, index) => <button key={src} type="button" onClick={() => setActive(index)}
          aria-label={'Show image ' + (index + 1)} aria-pressed={active === index}>
          <CatalogImage src={src} fill alt="" sizes="64px" />
        </button>)}
      </div>}
      <dialog ref={dialog} className="zoom-dialog" aria-label="Product image zoom" onKeyDown={(event) => {
          if (images.length > 1 && !zoomed && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            step(event.key === 'ArrowLeft' ? -1 : 1);
          }
        }} onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className="zoom-toolbar">
          {images.length > 1 && <div className="zoom-gallery-controls">
            <button className="icon-button" type="button" aria-label="Previous enlarged image" onClick={() => step(-1)}><ChevronLeft aria-hidden /></button>
            <span aria-live="polite">{active + 1} / {images.length}</span>
            <button className="icon-button" type="button" aria-label="Next enlarged image" onClick={() => step(1)}><ChevronRight aria-hidden /></button>
          </div>}
          <button className="icon-button" type="button" aria-label={zoomed ? 'Zoom out' : 'Zoom in'}
            aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>{zoomed ? <Minus aria-hidden /> : <Plus aria-hidden />}</button>
          <button className="icon-button" type="button" aria-label="Close image zoom" onClick={() => dialog.current?.close()}><X aria-hidden /></button>
        </div>
        <div className="zoom-scroll" ref={zoomScroll}>
          <div className={'zoom-image' + (zoomed ? ' is-magnified' : '')}>
            {open && <CatalogImage src={image} fill alt={product + ' — enlarged image'} sizes="(max-width: 760px) 100vw, 1050px" />}
          </div>
        </div>
      </dialog>
    </div>
  );
}

const optionKey = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const dimensionKey = (title: string) => optionKey(title).replace(/^colour$/, 'color');

function variantDimensions(variants: CatalogVariant[]) {
  const dimensions = new Map<string, { title: string; values: Map<string, string> }>();
  for (const variant of variants) {
    for (const [title, value] of Object.entries(variant.attributes)) {
      const key = dimensionKey(title);
      const dimension = dimensions.get(key) ?? { title: title.trim(), values: new Map<string, string>() };
      const normalized = optionKey(value);
      if (!dimension.values.has(normalized)) dimension.values.set(normalized, value.trim());
      dimensions.set(key, dimension);
    }
  }
  const priority = ['device', 'model', 'style', 'color', 'fit', 'size'];
  return [...dimensions].sort(([a], [b]) => (priority.includes(a) ? priority.indexOf(a) : priority.length)
    - (priority.includes(b) ? priority.indexOf(b) : priority.length));
}

function valuesFor(variant?: CatalogVariant) {
  return new Map(Object.entries(variant?.attributes ?? {}).map(([key, value]) => [dimensionKey(key), optionKey(value)]));
}

function chooseVariant(variants: CatalogVariant[], selected: CatalogVariant | undefined, dimension: string, value: string) {
  const current = valuesFor(selected);
  const candidates = variants.filter((variant) => {
    const values = valuesFor(variant);
    return values.get(dimension) === value && (dimension !== 'size' ||
      ['color', 'fit', 'style', 'model', 'device'].every(key => !current.has(key) || values.get(key) === current.get(key)));
  });
  function score(variant: CatalogVariant) {
    const values = valuesFor(variant);
    return [...current].filter(([key, value]) => key !== dimension && values.get(key) === value).length;
  }
  return candidates.reduce<CatalogVariant | undefined>((best, variant) => (
    !best || score(variant) > score(best) || (score(variant) === score(best) && variant.price && !best.price) ? variant : best
  ), undefined);
}

export function ProductExperience({ product, market, initialId, initialStock, extras, reviews, reviewsEnabled, reviewsWritable }: {
  product: CatalogProduct; market: Market; initialId?: string; initialStock: number | null;
  extras: Awaited<ReturnType<typeof merchandising>>; reviews: ReviewPage | null; reviewsEnabled: boolean; reviewsWritable: boolean;
}) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [reply, setReply] = useState<{ id: string; stock: number | null }>();
  const optionId = useId();
  const selected = product.variants.find((variant) => variant.id === selectedId);
  const price = selected?.price;
  const sold = formatUnitsSold(product.sold);
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
  const reviewTotal = reviews?.ratings.reduce((sum, count) => sum + count, 0) ?? 0;
  const showReviews = () => {
    const panel = document.querySelector<HTMLDetailsElement>('#product-reviews');
    if (panel) { panel.open = true; panel.scrollIntoView({ block: 'start' }); panel.querySelector('summary')?.focus({ preventScroll: true }); }
  };
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
        <div className="detail-summary">
          {product.brand && <p className="eyebrow">{product.brand.name}</p>}
          <h1>{product.name}</h1>
          <div className="detail-market" aria-live="polite">
            <div className="detail-price-line">
              {price && <p className="detail-price">{formatMoney(currentPrice(price), market)}
                {price.sale !== undefined && <del>{formatMoney(price.regular, market)}</del>}
              </p>}
              {badges.length > 0 && <ul className="detail-badges" aria-label="Product badges">
                {badges.map((badge) => <li data-badge={badge} key={badge}>{badge}</li>)}
              </ul>}
            </div>
            <p className="detail-stock" data-stock={knownStock === 0 ? 'out' : knownStock && price ? 'in' : 'unknown'}>{availability}</p>
          </div>
          <div className="detail-facts">
            {sold && <p className="detail-sold"><PackageCheck size={16} aria-hidden />{sold}</p>}
            {reviewTotal > 0 && <button type="button" className="text-link review-jump" onClick={showReviews}>{reviewTotal} {reviewTotal === 1 ? 'customer review' : 'customer reviews'}</button>}
            {(selected?.sku || product.sku) && <p className="detail-sku">SKU <span>{selected?.sku || product.sku}</span></p>}
          </div>
        </div>
        <FamilySelector family={extras.family} slug={product.slug} market={market} />
        {dimensions.length > 0 && <div className="variant-groups">
          {dimensions.map(([key, { title, values }], groupIndex) => <div key={key} className="variant-section">
            {key === 'size' && extras.guide && <SizeChart guide={extras.guide} product={product.name} />}
            <fieldset className="variant-group" data-dimension={key}>
              <legend>{title}{current.get(key) && <span> · {values.get(current.get(key)!)}</span>}</legend>
              {['device', 'model'].includes(key) && values.size > 4 ? <select aria-label={title} value={current.get(key) ?? ''}
                onChange={event => select(key, event.currentTarget.value)}>
                {!current.get(key) && <option value="" disabled>Choose {title.toLowerCase()}</option>}
                {[...values].map(([value, label]) => <option key={value} value={value} disabled={!chooseVariant(product.variants, selected, key, value)}>{label}</option>)}
              </select> : <div>{[...values].map(([value, label], valueIndex) => {
                const next = chooseVariant(product.variants, selected, key, value);
                const image = key === 'color' ? next?.images[0] : undefined;
                const soldOut = next && (next.id === selectedId && knownStock !== undefined ? knownStock : extras.stock[next.id]) === 0;
                const isSelected = current.get(key) === value;
                const stockLabelId = soldOut ? `${optionId}-${groupIndex}-${valueIndex}` : undefined;
                return <button type="button" key={value} className="variant-option" disabled={!next} data-sold-out={soldOut || undefined}
                  aria-label={title + ': ' + label} aria-describedby={stockLabelId}
                  aria-pressed={isSelected} onClick={() => select(key, value)}>
                  {image ? <span className="option-image"><CatalogImage src={image} alt="" fill sizes="74px" /></span>
                    : key === 'color' && next?.colorCode && <span className="option-swatch" style={{ backgroundColor: next.colorCode }} />}
                  <span className="option-label">{label}</span>{soldOut && <span className="option-stock" id={stockLabelId}>Sold out</span>}
                  {isSelected && <span className="option-selected"><Check size={12} aria-hidden /></span>}
                </button>;
              })}</div>}
            </fieldset>
          </div>)}
        </div>}
        {!dimensions.some(([key]) => key === 'size') && extras.guide && <SizeChart guide={extras.guide} product={product.name} />}
        {extras.guide?.note && <p className="detail-fit-note"><strong>Fit note</strong> {extras.guide.note}</p>}
        <AddToBag key={selectedId ?? product.id} product={product} variant={selected} stock={knownStock} showQuantity />
        <div className="product-utility" aria-label="Product actions" role="group">
          {price && <WishlistButton slug={product.slug} name={product.name} className="button button-outline detail-wish" showLabel />}
          <WatchButton slug={product.slug} market={market} />
          <ShareLink path={productHref(market, product.slug)} label="Share product" />
        </div>
        <ProductAddons addons={extras.addons} market={market} />
        <div className="product-information">
          {product.description && <details className="detail-accordion" open><summary>Product details</summary>
            <p className="detail-description">{product.description}</p></details>}
          {product.videos && product.videos.length > 0 && <ProductVideos videos={product.videos} />}
          <ProductReviews product={product} market={market} initial={reviews} enabled={reviewsEnabled} writable={reviewsWritable} />
          <DeliveryDetails product={product} market={market} />
          <SaveToCollection slug={product.slug} />
          {product.specifications.length > 0 && <details className="detail-accordion product-specifications">
            <summary>Specifications</summary>
            <dl>{product.specifications.map(({ title, values }, index) => <div key={title + index}><dt>{title}</dt><dd>{values.join(' · ')}</dd></div>)}</dl>
          </details>}
        </div>
      </div>
    </div>
  );
}
