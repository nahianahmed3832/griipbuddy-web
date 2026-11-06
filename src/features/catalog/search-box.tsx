'use client';

import { ArrowUpRight, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { marketHref, type Category, type Market, type Suggestion } from './catalog';

export function SearchBox({
  market, categories = [], style, initialQuery = '', initialCategory = '', onChoose, onFocus,
}: {
  market: Market;
  categories?: Category[];
  style: 'header' | 'drawer' | 'page';
  initialQuery?: string;
  initialCategory?: string;
  onChoose?: () => void;
  onFocus?: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState(initialCategory);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const [reply, setReply] = useState<{ key: string; matches: Suggestion[]; failed?: boolean }>();
  const clean = query.trim();
  const key = clean + '\n' + category;
  const open = focused && clean.length >= 2;
  const suggestions = reply?.key === key ? reply.matches : [];
  const action = marketHref(market, '/search');

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: clean, market: market.code, category });
        const response = await fetch('/api/catalog/suggest?' + params, { signal: controller.signal });
        if (!response.ok) throw new Error('Suggestions unavailable');
        const { suggestions } = await response.json() as { suggestions: Suggestion[] };
        if (!controller.signal.aborted) setReply({ key, matches: suggestions });
      } catch {
        if (!controller.signal.aborted) setReply({ key, matches: [], failed: true });
      }
    }, 240);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, clean, key, category, market.code]);

  function select() {
    const suggestion = suggestions[active];
    if (suggestion) {
      onChoose?.();
      window.location.assign(suggestion.href);
    }
  }

  return (
    <form className={'search-form ' + style + '-search'} role="search"
      aria-label={style === 'header' ? 'Storefront search' : style === 'page' ? 'Search results' : 'Mobile search'}
      method="get" action={action}
      onFocus={() => { setFocused(true); onFocus?.(); }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); setActive(-1); }
      }}
      onSubmit={(event) => {
        if (open && suggestions[active]) { event.preventDefault(); select(); }
      }}
    >
      {style === 'header' && categories.length > 0 && (
        <select className="search-category" name="category" aria-label="Search category" value={category}
          onChange={(event) => { setCategory(event.target.value); setActive(-1); }}>
          <option value="">All categories</option>
          {categories.map((entry) => <option key={entry.id} value={entry.slug}>{entry.label}</option>)}
        </select>
      )}
      {style !== 'header' && initialCategory && <input type="hidden" name="category" value={initialCategory} />}
      <input type="search" name="q" value={query} maxLength={100} aria-label="Search products"
        data-first-focus={style === 'drawer' ? '' : undefined} autoComplete="off"
        aria-controls={open ? id : undefined} aria-expanded={open} role="combobox" aria-autocomplete="list"
        aria-activedescendant={open && suggestions[active] ? id + '-' + active : undefined}
        placeholder={style === 'header' ? 'Search products' : 'Search the catalog'}
        onChange={(event) => { setQuery(event.target.value); setFocused(true); setActive(-1); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            if (style !== 'drawer') event.stopPropagation();
            setFocused(false);
            setActive(-1);
          }
          if (!open || !suggestions.length) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => event.key === 'ArrowDown'
              ? (index + 1) % suggestions.length
              : index <= 0 ? suggestions.length - 1 : index - 1);
          }
        }}
      />
      <button className={style === 'header' ? undefined : 'icon-button'} type="submit" aria-label="Search the store"><Search size={18} aria-hidden /></button>
      {open && (
        <div className="search-suggestions">
          <ul id={id} role="listbox" aria-label="Search suggestions">
            {suggestions.map((entry, index) => (
              <li key={entry.href} id={id + '-' + index} role="option" aria-selected={index === active}>
                <Link href={entry.href} tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => { setFocused(false); onChoose?.(); }}>
                  <span>{entry.title}</span><small>{entry.kind} <ArrowUpRight size={13} aria-hidden /></small>
                </Link>
              </li>
            ))}
          </ul>
          {!suggestions.length && <p role="status">{reply?.key !== key ? 'Finding suggestions…' : reply.failed ? 'Suggestions are unavailable.' : 'No matching suggestions.'}</p>}
        </div>
      )}
    </form>
  );
}
