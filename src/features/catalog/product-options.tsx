'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ImageIcon, Ruler, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AddToBag } from '@/features/cart/actions';
import { currentPrice, formatMoney, productHref, type CatalogVariant, type Market, type SizeGuide } from './catalog';
import type { Addon, FamilyLink } from './merchandising';

export function FamilySelector({ family, slug, market }: { family: FamilyLink[]; slug: string; market: Market }) {
  const rail = useRef<HTMLDivElement>(null);
  if (!family.length) return null;
  return <section className="family-selector" aria-label="Model or style">
    <div className="option-heading">
      <label className="option-title" htmlFor="linked-model">Model or style</label>
      <div className="rail-controls">
        <button type="button" aria-label="Previous models" onClick={() => rail.current?.scrollBy({ left: -240, behavior: 'smooth' })}><ChevronLeft size={16} aria-hidden /></button>
        <button type="button" aria-label="More models" onClick={() => rail.current?.scrollBy({ left: 240, behavior: 'smooth' })}><ChevronRight size={16} aria-hidden /></button>
      </div>
    </div>
    <select id="linked-model" value={slug} onChange={event => { window.location.assign(productHref(market, event.currentTarget.value)); }}>
      {family.map(model => <option value={model.slug} key={model.slug}>{model.label}</option>)}
    </select>
    <div className="family-rail" ref={rail}>
      {family.map(model => <Link key={model.slug} href={productHref(market, model.slug)}
        aria-current={model.slug === slug ? 'page' : undefined} prefetch={false}>
        <span className="option-image">{model.image
          ? <Image src={model.image} fill sizes="74px" alt="" unoptimized={model.image.startsWith('https://')} />
          : <ImageIcon aria-hidden size={17} />}</span><span>{model.label}</span>
      </Link>)}
    </div>
  </section>;
}

export function SizeChart({ guide, product }: { guide: SizeGuide; product: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState('Size chart');
  const [unit, setUnit] = useState<'cm' | 'in'>('cm');
  const fits = [...new Set(guide.rows.map(row => row.fit))];
  const tabs = [...(guide.models.length ? ['Models'] : []), 'Size chart', 'How to measure'];
  return <>
    <button className="size-chart-button text-link" type="button" onClick={() => dialog.current?.showModal()}><Ruler size={16} aria-hidden /> Size guide</button>
    <dialog ref={dialog} className="size-chart-dialog" aria-labelledby="size-chart-title"
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="size-chart-inner">
        <div className="size-chart-head">
          <div><p className="eyebrow">{product}</p><h2 id="size-chart-title">Size guide</h2></div>
          <button type="button" className="icon-button" aria-label="Close size guide" onClick={() => dialog.current?.close()}><X aria-hidden /></button>
        </div>
        <div className="size-chart-tabs" aria-label="Size guide view">
          {tabs.map(tab => <button type="button" key={tab} aria-pressed={view === tab} onClick={() => setView(tab)}>{tab}</button>)}
        </div>
        {view === 'Size chart' && <div className="size-chart-body">
          {guide.note && <p>{guide.note}</p>}
          <div className="size-chart-units" aria-label="Measurement units">
            {(['cm', 'in'] as const).map(value => <button key={value} className="variant-option" type="button" aria-pressed={unit === value}
              onClick={() => setUnit(value)}>{value === 'cm' ? 'Centimeters' : 'Inches'}</button>)}
          </div>
          {fits.map(fit => <div key={fit}>
            {fit && <h3>{fit}</h3>}
            <div className="size-table" role="region" aria-label={(fit || 'Size') + ' measurements'} tabIndex={0}>
              <table>
                <thead><tr><th scope="col">Size</th>{guide.columns.map(column => <th key={column} scope="col">{column} ({unit})</th>)}</tr></thead>
                <tbody>{guide.rows.filter(row => row.fit === fit).map(row => <tr key={row.size}><th scope="row">{row.size}</th>
                  {row.cm.map((cm, index) => <td key={index}>{unit === 'cm' ? cm : Number((cm / 2.54).toFixed(1))}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </div>)}
        </div>}
        {view === 'Models' && <div className="size-chart-body size-chart-models">
          {guide.models.map((model, index) => <figure key={index}>
            <Image src={model.image} width={360} height={450} unoptimized alt={'Fit on a model wearing size ' + model.size} />
            <figcaption>Wearing <strong>{model.size}</strong> · {model.height} cm tall</figcaption>
          </figure>)}
        </div>}
        {view === 'How to measure' && <div className="size-chart-body">
          <p className="size-instructions">{guide.instructions || 'Check whether the chart lists body or garment measurements. For garment measurements, lay a similar item flat and compare it with the chart.'}</p>
        </div>}
      </div>
    </dialog>
  </>;
}

function Accessory({ addon, market }: { addon: Addon; market: Market }) {
  const { product, initial } = addon;
  const [variant, setVariant] = useState<CatalogVariant>(initial);
  const [result, setResult] = useState<{ id: string; stock: number | null }>();
  const stock = variant.id === initial.id ? addon.stock : result?.id === variant.id ? result?.stock : undefined;
  useEffect(() => {
    if (variant.id === initial.id) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ market: market.code, product: product.slug, variant: variant.id });
    fetch('/api/catalog/stock?' + params, { signal: controller.signal })
      .then(async response => response.ok ? (await response.json()).stock as number | null : null)
      .catch(() => null)
      .then(value => { if (!controller.signal.aborted) setResult({ id: variant.id, stock: value }); });
    return () => controller.abort();
  }, [initial.id, market.code, product.slug, variant.id]);
  const image = variant.images[0] ?? product.images[0];
  const options = product.variants.filter(option => option.price);
  return <li className="accessory-row">
    <Link className="accessory-image option-image" href={productHref(market, product.slug)} tabIndex={-1} aria-hidden="true">
      {image ? <Image src={image} alt="" fill sizes="65px" unoptimized={image.startsWith('https://')} /> : <ImageIcon aria-hidden size={17} />}
    </Link>
    <div className="accessory-copy">
      <Link href={productHref(market, product.slug)}>{product.name}</Link>
      {variant.price && <span>{formatMoney(currentPrice(variant.price), market)}</span>}
      {options.length > 1 && <select aria-label={product.name + ' option'} value={variant.id} onChange={event => {
        const next = options.find(option => option.id === event.currentTarget.value);
        if (next) setVariant(next);
      }}>
        {options.map(option => <option value={option.id} key={option.id}>{Object.values(option.attributes).join(' / ') || option.sku}</option>)}
      </select>}
    </div>
    <div className="accessory-action">
      {stock === 0 && <small>Sold out</small>}
      <AddToBag key={variant.id} product={product} variant={variant} stock={stock} compact />
    </div>
  </li>;
}

export function ProductAddons({ addons, market }: { addons: Addon[]; market: Market }) {
  if (!addons.length) return null;
  return <section className="product-addons" aria-labelledby="product-addons-title">
    <h2 id="product-addons-title">Complete the set</h2>
    <ul>{addons.map(addon => <Accessory key={addon.product.id} addon={addon} market={market} />)}</ul>
  </section>;
}
