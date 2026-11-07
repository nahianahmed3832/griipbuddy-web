'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Eye, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { currentPrice, formatMoney, productHref, type Market } from './catalog';
import { lowestPricedVariant } from './browse';
import { useCatalogItems } from './use-catalog-items';

export function QuickView({ name, slug, market }: { name: string; slug: string; market: Market }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const { products, loading, failed } = useCatalogItems(market, open ? [slug] : []);
  const product = products[0];
  const variants = product?.variants.filter((item) => item.price) ?? [];
  const variant = variants.find((item) => item.id === selected) ?? lowestPricedVariant(variants);
  const src = variant?.images[0] ?? product?.images[0];
  const href = productHref(market, slug);

  return <>
    <button className="product-card-action" type="button" aria-label={'Quick view ' + name} onClick={() => {
      setOpen(true);
      dialog.current?.showModal();
    }}><Eye size={17} aria-hidden /></button>
    <dialog className="quick-dialog" ref={dialog} aria-labelledby={id} onClose={() => setOpen(false)}
      onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="quick-content">
        <button className="icon-button quick-close" type="button" aria-label="Close quick view" onClick={() => dialog.current?.close()}><X aria-hidden /></button>
        {src && <div className="quick-image"><Image src={src} alt="" fill sizes="(max-width: 640px) 90vw, 340px"
          unoptimized={src.startsWith('https://')} referrerPolicy="no-referrer" /></div>}
        <div className="quick-copy">
          <p className="eyebrow">QUICK VIEW</p><h2 id={id}>{name}</h2>
          {loading && <p role="status">Loading product…</p>}
          {failed && <p role="status">Preview unavailable. Open the product page to try again.</p>}
          {product?.description && <p>{product.description}</p>}
          {variants.length > 1 && <label>Options <select value={variant?.id ?? ''} onChange={(event) => setSelected(event.currentTarget.value)}>
            {variants.map((item) => <option key={item.id} value={item.id}>{Object.values(item.attributes).join(' · ') || item.sku || item.id}</option>)}
          </select></label>}
          {variant?.price && <p className="detail-price">{formatMoney(currentPrice(variant.price), market)}
            {variant.price.sale !== undefined && <del>{formatMoney(variant.price.regular, market)}</del>}</p>}
          <Link className="button button-primary" href={href + (variant ? '?variant=' + encodeURIComponent(variant.id) : '')}
            onClick={() => dialog.current?.close()}>View product <ArrowRight size={17} aria-hidden /></Link>
        </div>
      </div>
    </dialog>
  </>;
}
