"use client";

import Form from "next/form";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Folder, Search, Smartphone, Store, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { withoutRegionalPrefix } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { trackMeasurement } from "@/lib/measurement/browser";
import { MeasuredCategoryLink, MeasuredProductLink } from "./measurement-observers";
import "./search-form.css";

type NamedHit = { id: string; name: string; href: string };
type ProductHit = NamedHit & {
  variantId: string | null;
  offerId?: string | null;
  image: { src: string; alt: string } | null;
  amountMinor: number;
  priceQualifier?: "from" | "shown_option";
  currency: Market["currency"];
  match?: { kind: string; label: string } | null;
};
type Suggestions = {
  marketId: Market["id"];
  locale: string;
  products: ProductHit[];
  categories: NamedHit[];
  models: NamedHit[];
  shops: { id: string; name: string; slug: string }[];
};
type SearchScope = "classic" | "store" | "marketplace";
type SuggestionState = { key: string; data?: Suggestions };

function SuggestionGroup({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return <section aria-labelledby={heading}>
    <h2 id={heading} className="search-suggestions__heading">{title}</h2>
    <ul>{children}</ul>
  </section>;
}

export function SearchForm({ query = "", scope = "classic", market }: { query?: string; scope?: SearchScope; market: Market }) {
  const [value, setValue] = useState(query);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SuggestionState>();
  const input = useRef<HTMLInputElement>(null);
  const suggestions = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const popupId = useId();
  const search = value.trim();
  const key = JSON.stringify([market.id, market.locale, search]);
  const showing = open && search.length >= 2;
  const settled = results?.key === key ? results : undefined;
  const matched = showing ? settled?.data : undefined;
  const params = new URLSearchParams({ market: market.id, lang: market.locale, q: search });
  const searchHref = `/search?${params}`;

  useEffect(() => {
    if (!showing) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(storefrontPath(`/api/marketplace/suggest?${new URLSearchParams({ market: market.id, lang: market.locale, q: search })}`),
          { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Search suggestions unavailable.");
        const data = await response.json() as Suggestions;
        if (data.marketId !== market.id || data.locale !== market.locale || data.products.some(hit => hit.currency !== market.currency)) {
          throw new Error("Search market changed.");
        }
        if (!controller.signal.aborted) setResults({ key, data });
      } catch {
        if (!controller.signal.aborted) setResults({ key });
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [showing, search, key, market.id, market.locale, market.currency]);

  function changeValue(next: string) {
    if (next.trim() !== search) setResults(undefined);
    setValue(next);
    setOpen(true);
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && showing) {
      event.preventDefault();
      input.current?.focus();
      setOpen(false);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && showing) {
      const links = [...(suggestions.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])];
      if (!links.length) return;
      const current = links.findIndex(link => link === document.activeElement);
      const next = event.key === "ArrowDown" ? current + 1 : current < 0 ? links.length - 1 : current - 1;
      event.preventDefault();
      (links[next] ?? input.current)?.focus();
    }
  }

  const close = () => setOpen(false);
  const submitted = () => {
    close();
    if (search) trackMeasurement({ action: "SEARCH", searchStage: "submitted", marketId: market.id, placement: "search-box" });
  };
  const label = scope === "marketplace" ? "Search for items or shops" : "Search products";
  const landmark = scope === "marketplace" ? "Marketplace search" : scope === "store" ? "Store search" : "Product search";

  return <div className={scope === "classic" ? "catalog-search" : "catalog-search mp-search"} onKeyDown={keyboard}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
    <Form action="/search" className="search-form" role="search" aria-label={landmark} onSubmit={submitted}>
      <input type="hidden" name="market" value={market.id} />
      <input type="hidden" name="lang" value={market.locale} />
      <label htmlFor={inputId} className="sr-only">{label}</label>
      <input ref={input} id={inputId} aria-controls={showing ? popupId : undefined} name="q" type="search" value={value}
        maxLength={120} autoComplete="off" onFocus={() => setOpen(true)} onChange={event => changeValue(event.target.value)}
        placeholder={scope === "marketplace" ? "Search for anything" : "Search products"}/>
      {value && <button type="button" className="search-form__clear mp-search-clear" aria-label="Clear search"
        onClick={() => { changeValue(""); input.current?.focus(); }}><X aria-hidden="true" size={17} /></button>}
      <button type="submit" aria-label="Search"><Search aria-hidden="true" size={21} strokeWidth={2.2} /></button>
    </Form>
    {showing && <div id={popupId} ref={suggestions} className="search-suggestions" aria-label="Search suggestions" role="region" aria-busy={!settled}>
      {!settled && <p className="search-suggestions__message" role="status">Finding matches…</p>}
      {settled && !matched && <p className="search-suggestions__message" role="status">Suggestions are unavailable. You can still run a search.</p>}
      {matched && !matched.products.length && !matched.categories.length && !matched.models.length &&
        (scope !== "marketplace" || !matched.shops.length) && <p className="search-suggestions__message" role="status">No suggestions match.</p>}
      {!!matched?.products.length && <SuggestionGroup title="Products">
        {matched.products.map((hit, index) => <li key={hit.id}>
          <MeasuredProductLink card={{ id: hit.id, variantId: hit.variantId ?? undefined, offerId: hit.variantId ? hit.offerId ?? undefined : undefined,
            priceMinor: hit.amountMinor }} market={market} context={{ placement: "search-suggestion", position: index + 1 }}
            href={hit.href} prefetch={false} onClick={close}>
            {hit.image && <span className="search-suggestions__image">
              <Image src={storefrontPath(hit.image.src)} alt="" fill sizes="36px" unoptimized />
            </span>}
            <span className="search-suggestions__title"><strong>{hit.name}</strong>
              {hit.match && hit.match.kind !== "text" && <small>{hit.match.label}</small>}
            </span>
            <span className="search-suggestions__price">
              {hit.priceQualifier && <small>{hit.priceQualifier === "from" ? "From" : "Shown option"} </small>}
              {formatMoney(hit.amountMinor, market)}
            </span>
          </MeasuredProductLink>
        </li>)}
      </SuggestionGroup>}
      {!!matched?.models.length && <SuggestionGroup title="Device models">
        {matched.models.map(hit => <li key={hit.id}><Link href={hit.href} prefetch={false} onClick={() => {
          close();
          trackMeasurement({ action: "SEARCH", searchStage: "model-suggestion", marketId: market.id, placement: "search-model-suggestion" });
        }}><Smartphone aria-hidden="true" size={18} />{hit.name}</Link></li>)}
      </SuggestionGroup>}
      {!!matched?.categories.length && <SuggestionGroup title="Categories">
        {matched.categories.map((hit, index) => <li key={hit.id}><MeasuredCategoryLink href={hit.href} prefetch={false} onClick={close}
          categoryId={hit.id} marketId={market.id} context={{ placement: "search-category-suggestion", position: index + 1 }}>
          <Folder aria-hidden="true" size={18} />{hit.name}
        </MeasuredCategoryLink></li>)}
      </SuggestionGroup>}
      {scope === "marketplace" && !!matched?.shops.length && <SuggestionGroup title="Shops">
        {matched.shops.map(hit => <li key={hit.id}><Link href={`/shops/${encodeURIComponent(hit.slug)}`} prefetch={false} onClick={close}>
          <Store aria-hidden="true" size={18} />{hit.name}
        </Link></li>)}
      </SuggestionGroup>}
      <Link className="search-suggestions__all" href={searchHref} prefetch={false} onClick={submitted}>
        <Search aria-hidden="true" size={18} />Search for {search}
      </Link>
    </div>}
  </div>;
}

export function HeaderSearch({ market, scope }: { market: Market; scope?: SearchScope }) {
  const pathname = withoutRegionalPrefix(usePathname());
  const params = useSearchParams();
  const query = pathname === "/search" ? params.get("q")?.slice(0, 120) ?? "" : "";
  return <SearchForm key={`${market.id}:${market.locale}:${query}`} {...{ market, scope, query }} />;
}
