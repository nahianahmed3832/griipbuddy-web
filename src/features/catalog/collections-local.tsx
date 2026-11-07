'use client';

import { FolderHeart } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { productHref, validSlug, type Market } from './catalog';
import { updateBrowserList, useBrowserList } from './browser-lists';
import { useCatalogItems } from './use-catalog-items';

type Collection = { name: string; slugs: string[] };
const key = 'griipbuddy-saved-collections';
const maxCollections = 12;
const maxItems = 30;

function decode(items: string[]) {
  return items.flatMap((item): Collection[] => {
    try {
      const value = JSON.parse(item) as Partial<Collection> | null;
      if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 48 || !Array.isArray(value.slugs)) return [];
      return [{ name: value.name, slugs: [...new Set(value.slugs.filter((slug) => typeof slug === 'string' && validSlug(slug)))].slice(0, maxItems) }];
    } catch { return []; }
  }).slice(0, maxCollections);
}

function update(apply: (current: Collection[]) => Collection[]) {
  updateBrowserList(key, (items) => apply(decode(items)).map((item) => JSON.stringify(item)));
}

export function SaveToCollection({ slug }: { slug: string }) {
  const { items, hydrated } = useBrowserList(key);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const id = useId();
  const collections = decode(items);
  return <details className="detail-accordion collection-save">
    <summary>Save to collection</summary>
    <p>Organize finds into collections on this device.</p>
    {collections.length > 0 && <div className="collection-options">
      {collections.map((item) => {
        const saved = item.slugs.includes(slug);
        return <button className="button button-outline" type="button" key={item.name} aria-pressed={saved}
          disabled={!saved && item.slugs.length >= maxItems}
          onClick={() => update((current) => current.map((entry) => entry.name !== item.name ? entry : {
            ...entry, slugs: entry.slugs.includes(slug) ? entry.slugs.filter((value) => value !== slug) : [...entry.slugs, slug].slice(0, maxItems),
          }))}>{item.name}</button>;
      })}
    </div>}
    <form className="collection-create" onSubmit={(event) => {
      event.preventDefault();
      const title = name.trim();
      if (!title) return;
      if (collections.some((item) => item.name.toLowerCase() === title.toLowerCase())) {
        setMessage('Choose a different collection name.');
        return;
      }
      update((current) => current.length >= maxCollections || current.some((item) => item.name.toLowerCase() === title.toLowerCase())
        ? current : [...current, { name: title, slugs: [slug] }]);
      setMessage('Saved to ' + title + '.');
      setName('');
    }}>
      <label htmlFor={id}>New collection name</label>
      <div><input id={id} maxLength={48} required value={name} onChange={(event) => setName(event.currentTarget.value)} />
        <button className="button button-primary" type="submit" disabled={!hydrated || collections.length >= maxCollections}>Create and save</button></div>
    </form>
    {collections.length >= maxCollections && <p>You can keep up to {maxCollections} collections on this device.</p>}
    {message && <p role="status">{message}</p>}
  </details>;
}

export function SavedCollections({ market }: { market: Market }) {
  const { items } = useBrowserList(key);
  const collections = decode(items);
  const [selection, setSelection] = useState('');
  const selected = collections.find((item) => item.name === selection);
  const { products, loading, failed } = useCatalogItems(market, selected?.slugs ?? []);
  if (!collections.length) return null;
  return <section className="watchlist-panel saved-collections" aria-label="Saved collections">
    <div className="market-section-heading"><div><p className="eyebrow"><FolderHeart size={15} aria-hidden /> SAVED ON THIS DEVICE</p><h2>Saved collections</h2></div></div>
    <div className="collection-options">{collections.map((item) => <button key={item.name} className="button button-outline"
      type="button" aria-pressed={item.name === selection} onClick={() => setSelection(item.name)}>{item.name}</button>)}</div>
    {selected && <>
      {loading ? <p role="status">Loading collection…</p>
        : failed ? <p role="status">Could not load this collection. Try refreshing.</p>
          : products.length ? <ul>{products.map((product) => <li key={product.slug}>
            <Link href={productHref(market, product.slug)}>{product.name}</Link>
            <button className="text-link" type="button" aria-label={'Remove ' + product.name + ' from ' + selected.name}
              onClick={() => update((current) => current.map((item) => item.name === selected.name
                ? { ...item, slugs: item.slugs.filter((slug) => slug !== product.slug) } : item))}>Remove</button>
          </li>)}</ul> : <p>No products in this collection are available in this market.</p>}
      <button type="button" className="text-link" onClick={() => {
        update((current) => current.filter((item) => item.name !== selected.name));
        setSelection('');
      }}>Delete collection {selected.name}</button>
    </>}
  </section>;
}
