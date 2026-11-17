"use client";

import Form from "next/form";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Search, Store, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { markets, type MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { localizedStoreHref, marketStoreHref, withoutRegionalPrefix } from "@/config/regional-path";

type Match = { id: string; name: string; slug: string };
type Suggestion = { products: (Match & { variantId?: string })[]; shops: Match[] };

type SearchProps = { query?: string; firstParty?: boolean; marketId?: MarketId };

export function MarketplaceSearch({ query = "", firstParty = false, marketId }: SearchProps) {
  const [value, setValue] = useState(query);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<(Suggestion & { query: string; marketId?: MarketId }) | null>(null);
  const inputId = useId();
  const listId = `${inputId}-suggestions`;
  const instructionsId = `${inputId}-instructions`;
  const input = useRef<HTMLInputElement>(null);
  const suggestions = useRef<HTMLUListElement>(null);
  const pendingArrow = useRef<"ArrowDown" | "ArrowUp" | null>(null);
  const search = value.trim();
  const matched = open && results?.query === search && results.marketId === marketId ? results : null;
  const href = (path: string) => marketStoreHref(path, marketId);
  const searchPath = localizedStoreHref("/search", marketId);

  useEffect(() => {
    if (!open || search.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const parameters = new URLSearchParams({ q: search });
        if (marketId) parameters.set("market", marketId);
        const response = await fetch(storefrontPath(`/api/marketplace/suggest?${parameters}`), { signal: controller.signal });
        if (!response.ok) return;
        const matches: Suggestion = await response.json();
        if (!controller.signal.aborted) setResults({ ...matches, query: search, marketId });
      } catch { /* Submitting the search still works if suggestions are unavailable. */ }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [marketId, open, search]);

  useEffect(() => {
    if (!matched || !pendingArrow.current) return;
    const links = suggestions.current?.querySelectorAll("a");
    const arrow = pendingArrow.current;
    pendingArrow.current = null;
    if (links?.length && document.activeElement === input.current) {
      links[arrow === "ArrowDown" ? 0 : links.length - 1]?.focus();
    }
  }, [matched]);

  function closeSuggestions() {
    pendingArrow.current = null;
    setOpen(false);
  }

  function navigateSuggestions(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
      closeSuggestions();
      return;
    }
    if (event.shiftKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const links = Array.from(suggestions.current?.querySelectorAll("a") ?? []);
    const onInput = event.target === input.current;
    const index = links.findIndex(link => link === event.target);
    if (!onInput && index === -1) return;
    if (!links.length) {
      if (onInput && search.length >= 2) {
        event.preventDefault();
        pendingArrow.current = event.key;
        setOpen(true);
      }
      return;
    }
    event.preventDefault();
    if (onInput) links[event.key === "ArrowDown" ? 0 : links.length - 1]?.focus();
    else if (event.key === "ArrowUp" && index === 0) input.current?.focus();
    else links[Math.min(index + (event.key === "ArrowDown" ? 1 : -1), links.length - 1)]?.focus();
  }

  return <div className="mp-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeSuggestions(); }}
    onKeyDown={navigateSuggestions}>
    <Form action={searchPath} className="search-form" role="search" aria-label={firstParty ? "Store search" : "Marketplace search"} onSubmit={closeSuggestions}>
      {marketId && !markets[marketId].pathPrefix && <input type="hidden" name="market" value={marketId} />}
      <label htmlFor={inputId} className="sr-only">{firstParty ? "Search products" : "Search for items or shops"}</label>
      <input ref={input} id={inputId} name="q" value={value} maxLength={120} autoComplete="off" onFocus={() => setOpen(true)}
        aria-controls={matched ? listId : undefined} aria-describedby={matched ? instructionsId : undefined} onClick={() => setOpen(true)}
        onChange={event => { pendingArrow.current = null; setValue(event.target.value); setOpen(true); }} placeholder={firstParty ? "Search products" : "Search for anything"} />
      {value && <button type="button" className="mp-search-clear" aria-label="Clear search" onClick={() => { setValue(""); input.current?.focus(); }}><X size={17}/></button>}
      <button type="submit" aria-label="Search"><Search size={21} strokeWidth={2.2}/></button>
    </Form>
    {matched && <>
      <span className="sr-only" id={instructionsId}>Use the arrow keys to move through suggestions.</span>
      <ul ref={suggestions} id={listId} className="mp-suggestions" aria-label="Search suggestions">
        <li><Link href={href(`/search?q=${encodeURIComponent(search)}`)} onClick={closeSuggestions}><Search size={17} aria-hidden="true"/> Search for {search}</Link></li>
        {matched.products.map(hit => {
          const product = `/products/${encodeURIComponent(hit.slug)}`;
          const parameters = new URLSearchParams();
          if (hit.variantId) parameters.set("variant", hit.variantId);
          return <li key={hit.id}><Link href={href(parameters.size ? `${product}?${parameters}` : product)} onClick={closeSuggestions}><Search size={16} aria-hidden="true"/> {hit.name}</Link></li>;
        })}
        {!firstParty && <>
          {matched.shops.map(hit => <li key={hit.id}><Link href={href(`/shops/${encodeURIComponent(hit.slug)}`)} onClick={closeSuggestions}><Store size={17} aria-hidden="true"/> {hit.name}</Link></li>)}
          <li><Link href={href(`/shops?q=${encodeURIComponent(search)}`)} onClick={closeSuggestions}><Store size={17} aria-hidden="true"/> Find shops matching {search}</Link></li>
        </>}
      </ul>
    </>}
  </div>;
}

export function MarketplaceHeaderSearch(props: Omit<SearchProps, "query">) {
  const path = withoutRegionalPrefix(usePathname());
  const params = useSearchParams();
  const query = path === "/search" ? params.get("q")?.slice(0, 120) ?? "" : "";
  return <MarketplaceSearch key={`${props.marketId ?? ""}:${query}`} query={query} {...props}/>;
}
